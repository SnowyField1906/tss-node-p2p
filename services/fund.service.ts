import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { BN, SMT } from '@common'
import { Fund, FundDocument } from '@schemas'

@Injectable()
export class FundService {
    constructor(
        @InjectModel(Fund.name) private fundModel: Model<FundDocument>
    ) {}

    async getLatestState(
        chainId: string,
        userId: string
    ) {
        const chain = await this.fundModel.findOne({ chainId })
        if (!chain) {
            const emptyRoot = new SMT().getRoot()
            return {
                nonce: 0,
                root: emptyRoot,
                signature: null,
                oldBalance: '0',
                merkleProof: new SMT().prove(userId),
            }
        }

        const oldBalance = chain.balances[userId] || '0'
        const smt = this._buildSmt(chain.balances)
        const merkleProof = smt.prove(userId)

        return {
            nonce: chain.nonce,
            root: chain.root,
            signature: chain.signature,
            oldBalance,
            merkleProof,
        }
    }

    async commitTransaction(payload: TxPayload, signature: Signature) {
        const { chainId, userId, amount } = payload
        const chain = await this.fundModel.findOne({ chainId })

        if (chain && chain.signature && chain.signature.s === signature.s) {
            return // Prevent duplicate commits
        }

        const balances = chain?.balances || {}
        let nonce = chain?.nonce || 0

        const currentBalance = BN.from(balances[userId] || '0')
        balances[userId] = currentBalance.add(BN.from(amount)).toString(16)

        const smt = this._buildSmt(balances)
        const root = smt.getRoot()
        nonce += 1

        await this.fundModel.updateOne(
            { chainId },
            { $set: { balances, root, nonce, signature } },
            { upsert: true }
        )
    }

    async getMerkleProof(chainId: string, userId: string) {
        const chain = await this.fundModel.findOne({ chainId })
        const balances = chain ? chain.balances : {}
        const balance = balances[userId] || '0'

        const smt = this._buildSmt(balances)
        const proof = smt.prove(userId)

        return { balance, proof }
    }

    async getSettlementData(chainId: string) {
        const chain = await this.fundModel.findOne({ chainId })
        if (!chain) {
            return null
        }
        return {
            root: chain.root,
            nonce: chain.nonce,
            signature: chain.signature,
        }
    }

    private _buildSmt(balances: { [userId: string]: string }): SMT {
        const smt = new SMT()
        for (const [uid, bal] of Object.entries(balances)) {
            const uidHex = uid.padStart(40, '0')
            const balHex = bal.padStart(64, '0')
            smt.update(uidHex, uidHex + balHex)
        }
        return smt
    }
}
