import { HttpService } from '@nestjs/axios'
import { BadRequestException, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { BN, C, E, P } from '@common'
import {
    BroadcastDkgResponse,
    ComputePublicKeyRequest,
    ComputePublicKeyResponse,
    ReceiveDkgDataRequest,
    ReceiveDkgDataResponse,
} from '@dtos'
import { PVSS } from '@libs/pvss'
import { DkgState, DkgStateDocument, Key, KeyDocument, Share, ShareDocument } from '@schemas'

@Injectable()
export class DkgService {
    private nodeId: number
    private secret: string
    private publicKeys: { [j: number]: string }
    private nodes: { id: number; url: string }[]
    private threshold: number
    private n: number

    private pvss: PVSS

    constructor(
        @InjectModel(Key.name) private keyModel: Model<KeyDocument>,
        @InjectModel(Share.name) private shareModel: Model<ShareDocument>,
        @InjectModel(DkgState.name) private dkgStateModel: Model<DkgStateDocument>,
        private readonly configService: ConfigService,
        private readonly httpService: HttpService
    ) {
        this.nodeId = this.configService.get<number>('id')
        this.secret = this.configService.get<string>('privateKey')
        this.publicKeys = {}
        const networkPublicKeys = this.configService.get<Record<number, string>>('networkPublicKeys')
        for (const [j, Y_j] of Object.entries(networkPublicKeys)) {
            this.publicKeys[Number(j)] = Y_j
        }

        this.nodes = this.configService.get<{ id: number; url: string }[]>('nodes')
        this.threshold = Number(this.configService.get<number>('threshold'))
        this.n = this.nodes.length

        this.pvss = new PVSS()
    }

    async broadcastDkgShares(): Promise<BroadcastDkgResponse> {
        await this.keyModel.deleteMany({})
        await this.shareModel.deleteMany({})
        await this.dkgStateModel.deleteMany({})

        const paillier = await P.generateKeyPair(1024)

        const f_poly = this.pvss.generatePolynomial(BN.from(this.secret), this.threshold - 1)
        const noise = BN.from(C.generatePrivateKey())
        const g_poly = this.pvss.generatePolynomial(noise, this.threshold - 1)

        const commitments = this.pvss.generatePedersenCommitments(f_poly, g_poly)

        await this.keyModel.updateOne(
            {},
            { paillier, f_poly: f_poly.map((p) => p.toString(16)), chains: {} },
            { upsert: true }
        )

        await this.dkgStateModel.create({})

        const sharePromises = []
        for (let j = 1; j <= this.n; j++) {
            const s = this.pvss.evaluatePolynomial(f_poly, BN.from(j))
            const t = this.pvss.evaluatePolynomial(g_poly, BN.from(j))

            const payload = { s: s.toString(16), t: t.toString(16), ...paillier.publicKey }
            const payloadHex = Buffer.from(JSON.stringify(payload)).toString('hex')
            const encryptedPayload = await E.encrypt(this.publicKeys[j], payloadHex)

            const shareData = {
                from: this.nodeId,
                encryptedPayload,
                commitments,
            }

            if (j === this.nodeId) {
                this.receiveDkgShares(shareData).catch(() => null)
            } else {
                const peer = this.nodes.find((n) => n.id === j)
                if (peer) {
                    sharePromises.push(
                        this.httpService
                            .post(`${peer.url}/dkg/receive`, shareData)
                            .toPromise()
                            .catch(() => null)
                    )
                }
            }
        }
        await Promise.all(sharePromises)

        const state = await this.dkgStateModel.findOne({})
        if ((state?.shares?.length || 0) === this.n && !state.x_i) {
            await this.transitionToFeldman(state).catch(() => null)
        }

        return { success: true }
    }

    async receiveDkgShares(data: ReceiveDkgDataRequest): Promise<ReceiveDkgDataResponse> {
        const state = await this.dkgStateModel.findOneAndUpdate(
            {},
            { $addToSet: { shares: data } },
            { new: true, upsert: true }
        )

        if ((state.shares?.length || 0) === this.n && !state.x_i) {
            const keyDoc = await this.keyModel.findOne({})
            if (keyDoc) {
                await this.transitionToFeldman(state).catch(console.error)
            }
        }
        return { status: 'OK' }
    }

    private async transitionToFeldman(state: DkgStateDocument) {
        state = await this.dkgStateModel.findOneAndUpdate(
            { x_i: { $exists: false } },
            { $set: { x_i: 'processing' } },
            { new: true }
        )
        if (!state) return

        let x_i = BN.ZERO
        for (const share of state.shares) {
            const decryptedHex = await E.decrypt(this.secret, share.encryptedPayload)
            const parsed = JSON.parse(Buffer.from(decryptedHex, 'hex').toString('utf8'))

            const isValid = this.pvss.verifyShare(
                BN.from(this.nodeId),
                BN.from(parsed.s),
                BN.from(parsed.t),
                share.commitments
            )

            if (!isValid) {
                throw new BadRequestException(`Invalid PVSS share from node ${share.from}`)
            }

            const paillierPublicKey = { n: parsed.n, g: parsed.g }
            await this.shareModel.updateOne(
                { i: share.from },
                { s_ij: parsed.s, t_ij: parsed.t, paillierPublicKey },
                { upsert: true }
            )

            x_i = x_i.add(BN.from(parsed.s)).umod(C.ORDER)
        }

        const keyDoc = await this.keyModel.findOne({})
        if (!keyDoc || !keyDoc.f_poly) {
            throw new BadRequestException('Key document or f_poly not found')
        }

        await this.keyModel.updateOne({}, { x_i: x_i.toString(16) })
        await this.dkgStateModel.updateOne({}, { $set: { x_i: x_i.toString(16) } })

        const f_poly = keyDoc.f_poly.map((p) => BN.from(p))
        const feldmanCommitments = this.pvss.generateFeldmanCommitments(f_poly)

        const feldmanData = {
            from: this.nodeId,
            feldmanCommitments,
        }

        const feldmanPromises = []
        this.nodes.forEach((peer) => {
            if (peer.id === this.nodeId) {
                this.computePublicKey(feldmanData).catch(() => null)
            } else {
                feldmanPromises.push(
                    this.httpService
                        .post(`${peer.url}/dkg/compute-public-key`, feldmanData)
                        .toPromise()
                        .catch(() => null)
                )
            }
        })
        await Promise.all(feldmanPromises)
    }

    async computePublicKey(data: ComputePublicKeyRequest): Promise<ComputePublicKeyResponse> {
        const state = await this.dkgStateModel.findOneAndUpdate(
            {},
            { $addToSet: { feldmans: data } },
            { new: true, upsert: true }
        )

        if ((state.feldmans?.length || 0) === this.n && state.x_i && state.x_i !== 'processing') {
            this.finalizeDkg(state).catch(console.error)
        }
        return { status: 'OK' }
    }

    private async finalizeDkg(state: DkgStateDocument) {
        state = await this.dkgStateModel.findOneAndDelete({})
        if (!state) return

        const feldmanMatrix: string[][] = []
        // Ensure feldman commitments are correctly ordered by node id 1..n
        const sortedFeldmans = [...state.feldmans].sort((a, b) => a.from - b.from)
        for (const f of sortedFeldmans) {
            feldmanMatrix.push(f.feldmanCommitments)
        }

        const x_i = BN.from(state.x_i, 16)
        const isMasterShareValid = this.pvss.verifyMasterShare(BN.from(this.nodeId), x_i, feldmanMatrix)
        if (!isMasterShareValid) {
            throw new BadRequestException('Master share verification failed. DKG aborted.')
        }

        // Y = Sum(A_{j,0})
        let Y_point: any = null
        for (const commitments of feldmanMatrix) {
            const A_j0 = C.secp256k1.curve.decodePoint(commitments[0], 'hex')
            Y_point = Y_point ? Y_point.add(A_j0) : A_j0
        }
        const Y = Y_point.encode('hex', false)
        await this.keyModel.updateOne({}, { Y })

        return { success: true }
    }
}
