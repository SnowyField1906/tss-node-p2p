import { HttpService } from '@nestjs/axios'
import { BadRequestException, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { firstValueFrom } from 'rxjs'

import { BN, C, H, P, SMT } from '@common'
import {
    TssDeltaRequest,
    TssDeltaResponse,
    TssMtaRequest,
    TssMtaResponse,
    TssSignRequest,
    TssSignResponse,
    TssStartRequest,
    TssStartResponse,
} from '@dtos'
import {
    Key,
    KeyDocument,
    PendingTransaction,
    PendingTransactionDocument,
    Share,
    ShareDocument,
    TssState,
    TssStateDocument,
} from '@schemas'

import { FundService } from './fund.service'

@Injectable()
export class TssService {
    private nodeId: number
    private nodes: { id: number; url: string }[]
    private threshold: number

    constructor(
        @InjectModel(Key.name) private keyModel: Model<KeyDocument>,
        @InjectModel(Share.name) private shareModel: Model<ShareDocument>,
        @InjectModel(TssState.name) private tssStateModel: Model<TssStateDocument>,
        @InjectModel(PendingTransaction.name) private pendingTransactionModel: Model<PendingTransactionDocument>,
        private readonly configService: ConfigService,
        private readonly httpService: HttpService,
        private readonly fundService: FundService
    ) {
        this.nodeId = this.configService.get<number>('id')
        this.nodes = this.configService.get<{ id: number; url: string }[]>('nodes')
        this.threshold = Number(this.configService.get<number>('threshold'))
    }

    async proposeTransaction(chainId: string, userId: string, amountHex: string) {
        const key = await this.keyModel.findOne({})
        let isNewChain = false

        if (!key.chains) {
            key.chains = {}
            isNewChain = true
        }
        if (!key.chains[chainId]) {
            key.chains[chainId] = { nonce: 0, root: new SMT().getRoot() }
            isNewChain = true
        }
        if (isNewChain) {
            await this.keyModel.updateOne({}, { $set: { [`chains.${chainId}`]: key.chains[chainId] } })
        }

        const localState = key.chains[chainId]

        const peers = this.nodes.filter((n) => n.id !== this.nodeId)
        const syncPromises = peers.map((peer) =>
            firstValueFrom(this.httpService.get(`${peer.url}/fund/latest-state`, { params: { chainId, userId } }))
                .then((res) => res.data as LatestState)
                .catch(() => null)
        )
        const peerStates = (await Promise.all(syncPromises)).filter((s) => s !== null) as LatestState[]
        peerStates.sort((a, b) => b.nonce - a.nonce)

        const catchupStates = peerStates.filter((s) => s.nonce >= localState.nonce)

        let latestState: LatestState | null = null
        let foundValidRoot = false

        for (const state of catchupStates) {
            if (state.nonce === 0) {
                foundValidRoot = true
            } else {
                const syncMessage = H.sha256(
                    Buffer.concat([
                        Buffer.from(chainId),
                        Buffer.from(state.nonce.toString()),
                        Buffer.from(state.root, 'hex'),
                    ] as any)
                )
                const verifierKey = C.secp256k1.keyFromPublic(key.Y, 'hex')
                try {
                    if (state.signature && verifierKey.verify(syncMessage, state.signature)) {
                        foundValidRoot = true
                    }
                } catch (e) {}
            }

            if (foundValidRoot) {
                const smt = new SMT()
                const userIdHex = userId.padStart(40, '0')
                const oldBalanceHex = state.oldBalance.padStart(64, '0')
                const oldLeaf = userIdHex + oldBalanceHex
                let isProofValid = smt.verify(userIdHex, oldLeaf, state.merkleProof, state.root)
                if (!isProofValid && BN.from(state.oldBalance).isZero()) {
                    isProofValid = smt.verify(userIdHex, '00', state.merkleProof, state.root)
                }

                if (!isProofValid) {
                    throw new BadRequestException('Merkle proof is incorrect for a valid root')
                }

                latestState = state
                break
            }
        }

        if (catchupStates.length > 0 && !foundValidRoot && localState.nonce < catchupStates[0].nonce) {
            throw new BadRequestException('No valid root found from peers')
        }

        if (!latestState) {
            latestState = await this.fundService.getLatestState(chainId, userId)
        }

        if (latestState.nonce > localState.nonce) {
            localState.nonce = latestState.nonce
            localState.root = latestState.root
            await this.keyModel.updateOne({}, { $set: { [`chains.${chainId}`]: localState } })
        }

        const smt = new SMT()
        const userIdHex = userId.padStart(40, '0')
        const newBalance = BN.from(latestState.oldBalance).add(BN.from(amountHex))
        const newBalanceHex = newBalance.toString(16).padStart(64, '0')
        const newLeaf = userIdHex + newBalanceHex
        const newRoot = smt.computeRootFromProof(userIdHex, newLeaf, latestState.merkleProof)

        const newNonce = localState.nonce + 1
        const messagePayload = Buffer.concat([
            Buffer.from(chainId),
            Buffer.from(newNonce.toString()),
            Buffer.from(newRoot, 'hex'),
        ] as any) as any
        const messageHash = H.sha256(messagePayload)

        await this.pendingTransactionModel.findOneAndUpdate(
            { chainId },
            { newRoot, newNonce, messageHash },
            { upsert: true }
        )

        const payload = { chainId, userId, amount: amountHex } as any

        await this.tssStart(
            this.nodeId,
            messageHash,
            payload,
            true
        )

        return { messageHash }
    }

    async tssStart(
        i: number,
        messageHash: string,
        payload: any,
        isProposer: boolean = false,
        E_k?: string,
        E_x?: string,
        Gamma?: string
    ): Promise<TssStartResponse> {

        let state = await this.tssStateModel.findOneAndUpdate(
            { messageHash },
            { $setOnInsert: { payload } },
            { upsert: true, new: true }
        )

        if (E_k && E_x && Gamma) {
            state = await this.tssStateModel.findOneAndUpdate(
                { messageHash },
                { $addToSet: { starts: { i, E_k, E_x, Gamma } } },
                { new: true }
            )
        }

        if (isProposer && !state.k_i) {
            const key = await this.keyModel.findOne({})
            const k_i = BN.from(C.generatePrivateKey()).umod(C.ORDER)
            const gamma_i = BN.from(C.generatePrivateKey()).umod(C.ORDER)
            const Gamma_i = C.secp256k1.curve.g.mul(gamma_i).encode('hex', false)
            const E_k_i = P.encrypt(key.paillier.publicKey, k_i).toString(16)
            const E_x_i = P.encrypt(key.paillier.publicKey, BN.from(key.x_i)).toString(16)

            state = await this.tssStateModel.findOneAndUpdate(
                { messageHash },
                {
                    $set: { k_i: k_i.toString(16), gamma_i: gamma_i.toString(16) },
                    $addToSet: { starts: { i: this.nodeId, E_k: E_k_i, E_x: E_x_i, Gamma: Gamma_i } },
                },
                { new: true }
            )

            const peers = this.nodes.filter((n) => n.id !== this.nodeId)
            peers.forEach((peer) => {
                this.httpService
                    .post(`${peer.url}/tss/start`, {
                        i: this.nodeId,
                        messageHash,
                        payload,
                        E_k: E_k_i,
                        E_x: E_x_i,
                        Gamma: Gamma_i,
                    })
                    .toPromise()
                    .catch(() => null)
            })
        }

        if ((state.starts?.length || 0) === this.threshold && state.k_i && !state.w_i) {
            await this.transitionToMtA(messageHash, state)
        }
        return { status: 'OK' }
    }

    private async transitionToMtA(messageHash: string, state: TssStateDocument) {
        state = await this.tssStateModel.findOneAndUpdate(
            { messageHash, w_i: { $exists: false } },
            { $set: { w_i: 'processing' } },
            { new: true }
        )
        if (!state) return

        const key = await this.keyModel.findOne({})
        const subset = state.starts.map((s) => s.i)

        let lambda_i = BN.ONE
        for (const j of subset) {
            if (j === this.nodeId) continue
            const top = BN.from(j).neg().umod(C.ORDER)
            const bottom = BN.from(this.nodeId).sub(BN.from(j)).umod(C.ORDER)
            lambda_i = lambda_i.mul(top.mul(bottom.invm(C.ORDER))).umod(C.ORDER)
        }

        const w_i = BN.from(key.x_i).mul(lambda_i).umod(C.ORDER)

        const betasToSave: any = {}
        const musToSave: any = {}
        const mtaPromises = []

        for (const peerStart of state.starts) {
            if (peerStart.i === this.nodeId) continue

            const share = await this.shareModel.findOne({ i: peerStart.i })
            const otherPublicKey = share.paillierPublicKey

            let lambda_j = BN.ONE
            for (const k of subset) {
                if (k === peerStart.i) continue
                const top = BN.from(k).neg().umod(C.ORDER)
                const bottom = BN.from(peerStart.i).sub(BN.from(k)).umod(C.ORDER)
                lambda_j = lambda_j.mul(top.mul(bottom.invm(C.ORDER))).umod(C.ORDER)
            }

            const E_x_j = BN.from(peerStart.E_x, 16)
            const E_w_j = P.multiply(otherPublicKey, E_x_j, lambda_j)

            const beta_prime = BN.from(C.generatePrivateKey()).umod(C.ORDER)
            const beta_ij = C.ORDER.sub(beta_prime).umod(C.ORDER)
            betasToSave[peerStart.i.toString()] = beta_ij.toString(16)

            const term1_k = P.multiply(otherPublicKey, BN.from(peerStart.E_k, 16), BN.from(state.gamma_i, 16))
            const alpha_ij = P.add(otherPublicKey, term1_k, P.encrypt(otherPublicKey, beta_prime))

            const mu_prime = BN.from(C.generatePrivateKey()).umod(C.ORDER)
            const mu_ij = C.ORDER.sub(mu_prime).umod(C.ORDER)
            musToSave[peerStart.i.toString()] = mu_ij.toString(16)

            const term1_x = P.multiply(otherPublicKey, E_w_j, BN.from(state.k_i, 16))
            const nu_ij = P.add(otherPublicKey, term1_x, P.encrypt(otherPublicKey, mu_prime))

            const peer = this.nodes.find((n) => n.id === peerStart.i)
            mtaPromises.push(
                this.httpService
                    .post(`${peer.url}/tss/mta`, {
                        messageHash,
                        from: this.nodeId,
                        alpha: alpha_ij.toString(16),
                        nu: nu_ij.toString(16),
                    })
                    .toPromise()
                    .catch(() => null)
            )
        }

        const updatedState = await this.tssStateModel.findOneAndUpdate(
            { messageHash },
            { $set: { w_i: w_i.toString(16), betas: betasToSave, mus: musToSave } },
            { new: true }
        )

        await Promise.all(mtaPromises)

        if ((updatedState.mtas?.length || 0) === this.threshold - 1) {
            await this.transitionToDelta(messageHash, updatedState)
        }
    }

    async tssMta(
        messageHash: string,
        from: number,
        alpha: string,
        nu: string
    ): Promise<TssMtaResponse> {
        const state = await this.tssStateModel.findOneAndUpdate(
            { messageHash },
            { $addToSet: { mtas: { from, alpha, nu } } },
            { new: true }
        )
        if (
            (state.mtas?.length || 0) === this.threshold - 1 &&
            state.w_i &&
            state.w_i !== 'processing' &&
            !state.sigma_i
        ) {
            await this.transitionToDelta(messageHash, state)
        }
        return { status: 'OK' }
    }

    private async transitionToDelta(messageHash: string, state: TssStateDocument) {
        state = await this.tssStateModel.findOneAndUpdate(
            { messageHash, sigma_i: { $exists: false } },
            { $set: { sigma_i: 'processing' } },
            { new: true }
        )
        if (!state) return

        const key = await this.keyModel.findOne({})

        let delta_i = BN.from(state.k_i, 16).mul(BN.from(state.gamma_i, 16)).umod(C.ORDER)
        for (const mta of state.mtas) {
            const alpha_ji = P.decrypt(key.paillier, BN.from(mta.alpha, 16)).umod(C.ORDER)
            delta_i = delta_i.add(alpha_ji).umod(C.ORDER)
        }
        for (const beta of Object.values(state.betas || {})) {
            delta_i = delta_i.add(BN.from(beta, 16)).umod(C.ORDER)
        }

        let sigma_i = BN.from(state.k_i, 16).mul(BN.from(state.w_i, 16)).umod(C.ORDER)
        for (const mta of state.mtas) {
            const nu_ji = P.decrypt(key.paillier, BN.from(mta.nu, 16)).umod(C.ORDER)
            sigma_i = sigma_i.add(nu_ji).umod(C.ORDER)
        }
        for (const mu of Object.values(state.mus || {})) {
            sigma_i = sigma_i.add(BN.from(mu, 16)).umod(C.ORDER)
        }

        await this.tssStateModel.updateOne({ messageHash }, { $set: { sigma_i: sigma_i.toString(16) } })

        const subset = state.starts.map((s) => s.i)
        const deltaPromises = []
        subset.forEach((j) => {
            if (j === this.nodeId) {
                this.tssDelta(messageHash, this.nodeId, delta_i.toString(16))
            } else {
                const peer = this.nodes.find((n) => n.id === j)
                if (peer) {
                    deltaPromises.push(
                        this.httpService
                            .post(`${peer.url}/tss/delta`, {
                                messageHash,
                                from: this.nodeId,
                                delta: delta_i.toString(16),
                            })
                            .toPromise()
                            .catch(() => null)
                    )
                }
            }
        })
        await Promise.all(deltaPromises)
    }

    async tssDelta(
        messageHash: string,
        from: number,
        delta: string
    ): Promise<TssDeltaResponse> {
        const state = await this.tssStateModel.findOneAndUpdate(
            { messageHash },
            { $addToSet: { deltas: { from, delta } } },
            { new: true }
        )
        if (
            (state.deltas?.length || 0) === this.threshold &&
            state.sigma_i &&
            state.sigma_i !== 'processing' &&
            !state.r
        ) {
            await this.transitionToSign(messageHash, state)
        }
        return { status: 'OK' }
    }

    private async transitionToSign(messageHash: string, state: TssStateDocument) {
        state = await this.tssStateModel.findOneAndUpdate(
            { messageHash, r: { $exists: false } },
            { $set: { r: 'processing' } },
            { new: true }
        )
        if (!state) return

        let deltaSum = BN.ZERO
        for (const d of state.deltas) {
            deltaSum = deltaSum.add(BN.from(d.delta, 16)).umod(C.ORDER)
        }
        const delta_inv = deltaSum.invm(C.ORDER)

        let GammaSum: any = null
        for (const s of state.starts) {
            const Gamma_i = C.secp256k1.curve.decodePoint(s.Gamma, 'hex')
            if (GammaSum === null) GammaSum = Gamma_i
            else GammaSum = GammaSum.add(Gamma_i)
        }

        const R = GammaSum.mul(delta_inv)
        const r = R.getX().umod(C.ORDER)
        await this.tssStateModel.updateOne({ messageHash }, { $set: { r: r.toString(16) } })

        const m = BN.from(messageHash, 16).umod(C.ORDER)
        const k_i = BN.from(state.k_i, 16)
        const sigma_i = BN.from(state.sigma_i, 16)

        const s_i = m.mul(k_i).add(r.mul(sigma_i)).umod(C.ORDER)

        const subset = state.starts.map((s) => s.i)
        const signPromises = []
        subset.forEach((j) => {
            if (j === this.nodeId) {
                this.tssSign(messageHash, this.nodeId, s_i.toString(16))
            } else {
                const peer = this.nodes.find((n) => n.id === j)
                if (peer) {
                    signPromises.push(
                        this.httpService
                            .post(`${peer.url}/tss/sign`, {
                                messageHash,
                                from: this.nodeId,
                                s_i: s_i.toString(16),
                            })
                            .toPromise()
                            .catch(() => null)
                    )
                }
            }
        })
        await Promise.all(signPromises)
    }

    async tssSign(
        messageHash: string,
        from: number,
        s_i: string
    ): Promise<TssSignResponse> {
        const state = await this.tssStateModel.findOneAndUpdate(
            { messageHash },
            { $addToSet: { signs: { from, s_i } } },
            { new: true }
        )

        if ((state.signs?.length || 0) === this.threshold && state.r && state.r !== 'processing' && !state.finished) {
            await this.finalizeTransaction(messageHash, state)
        }
        return { status: 'OK' }
    }

    private async finalizeTransaction(messageHash: string, state: TssStateDocument) {
        state = await this.tssStateModel.findOneAndUpdate(
            { messageHash, finished: { $ne: true } },
            { $set: { finished: true } },
            { new: true }
        )
        if (!state) return

        let s = BN.ZERO
        for (const sign of state.signs) {
            s = s.add(BN.from(sign.s_i, 16)).umod(C.ORDER)
        }

        const halfOrder = C.ORDER.shrn(1)
        if (s.cmp(halfOrder) > 0) {
            s = C.ORDER.sub(s)
        }

        const payload = state.payload
        const signature = { r: state.r, s: s.toString(16) }

        await this.fundService.commitTransaction(payload, signature)

        const pendingTx = await this.pendingTransactionModel.findOne({ messageHash })

        if (pendingTx) {
            const chainId = pendingTx.chainId
            const key = await this.keyModel.findOne({})
            if (!key.chains) key.chains = {}
            if (!key.chains[chainId]) key.chains[chainId] = { nonce: 0, root: new SMT().getRoot() }
            key.chains[chainId].root = pendingTx.newRoot
            key.chains[chainId].nonce = pendingTx.newNonce
            await this.keyModel.updateOne({}, { $set: { [`chains.${chainId}`]: key.chains[chainId] } })
            await this.pendingTransactionModel.deleteOne({ messageHash })
        }

        const peers = this.nodes.filter((n) => n.id !== this.nodeId)
        peers.forEach((peer) => {
            this.httpService
                .post(`${peer.url}/fund/commit`, { payload, signature })
                .toPromise()
                .catch(() => null)
        })

        await this.tssStateModel.deleteOne({ messageHash })
    }
}
