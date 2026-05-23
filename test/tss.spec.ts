import { ConfigService } from '@nestjs/config'
import { of } from 'rxjs'

import { BN, C, SMT } from '@common'
import { DkgService } from '@services/dkg.service'
import { FundService } from '@services/fund.service'
import { TssService } from '@services/tss.service'

const mockData = {
    1: C.generateKeyPair(),
    2: C.generateKeyPair(),
    3: C.generateKeyPair(),
}
class MockModel {
    private data: any[] = []
    private matchQuery(item: any, query: any) {
        return Object.keys(query).every((k) => {
            if (k === 'proposers') return item.proposers && item.proposers.includes(query[k])
            if (query[k] && typeof query[k] === 'object' && '$exists' in query[k]) {
                const exists = query[k].$exists
                if (exists) return item[k] !== undefined
                else return item[k] === undefined
            }
            if (query[k] && typeof query[k] === 'object' && '$ne' in query[k]) {
                return item[k] !== query[k].$ne
            }
            return item[k] === query[k]
        })
    }
    
    async deleteMany(query: any = {}) {
        if (query.proposers && query.proposers.$size === 0) {
            this.data = this.data.filter((item) => !(item.proposers && item.proposers.length === 0))
            return { acknowledged: true, deletedCount: 0 }
        }
        this.data = []
        return { acknowledged: true, deletedCount: this.data.length }
    }
    async deleteOne(query: any = {}) {
        const index = this.data.findIndex((item) => this.matchQuery(item, query))
        if (index > -1) this.data.splice(index, 1)
    }
    async findOne(query: any = {}) {
        return this.data.find((item) => this.matchQuery(item, query)) || null
    }
    async find(query: any = {}) {
        return this.data.filter((item) => this.matchQuery(item, query))
    }
    private applyUpdate(item: any, update: any) {
        for (const [key, value] of Object.entries(update)) {
            if (key.includes('.')) {
                const parts = key.split('.')
                let current = item
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!current[parts[i]]) current[parts[i]] = {}
                    current = current[parts[i]]
                }
                current[parts[parts.length - 1]] = value
            } else {
                item[key] = value
            }
        }
    }

    async updateOne(query: any = {}, updateData: any = {}, options: any = {}) {
        const update = updateData.$set || updateData
        const index = this.data.findIndex((item) => this.matchQuery(item, query))
        if (index > -1) {
            this.applyUpdate(this.data[index], update)
        } else if (options.upsert) {
            const newItem = { ...query }
            this.applyUpdate(newItem, update)
            this.data.push(newItem)
        }
    }
    async updateMany(query: any = {}, updateData: any = {}) {
        const { $pull } = updateData
        if ($pull) {
            for (const item of this.data) {
                if (this.matchQuery(item, query) && $pull.proposers !== undefined) {
                    item.proposers = item.proposers.filter((p: number) => p !== $pull.proposers)
                }
            }
        }
    }
    async findOneAndUpdate(query: any = {}, updateData: any = {}, options: any = {}) {
        const { $set, $addToSet, $setOnInsert, ...plainFields } = updateData
        const update = { ...(plainFields || {}), ...($set || {}) }
        const addToSet = $addToSet || {}
        
        let index = this.data.findIndex((item) => this.matchQuery(item, query))
        
        if (index === -1 && options.upsert) {
            const newItem: any = { ...query, ...($setOnInsert || {}) }
            this.applyUpdate(newItem, update)
            for (const [key, val] of Object.entries(addToSet)) {
                newItem[key] = [val]
            }
            this.data.push(newItem)
            index = this.data.length - 1
        } else if (index > -1) {
            this.applyUpdate(this.data[index], update)
            for (const [key, val] of Object.entries(addToSet)) {
                if (!this.data[index][key]) this.data[index][key] = []
                const exists = this.data[index][key].find((x: any) => JSON.stringify(x) === JSON.stringify(val))
                if (!exists) this.data[index][key].push(val)
            }
        }
        
        if (index > -1) {
            return options.new ? this.data[index] : null // Mock simplification
        }
        return null
    }
}

const nodesConfig = [
    { id: 1, url: 'http://localhost:3001' },
    { id: 2, url: 'http://localhost:3002' },
    { id: 3, url: 'http://localhost:3003' },
]

const createMock = (id: number) => {
    const privateKey = mockData[id as keyof typeof mockData].getPrivate('hex')
    const config = {
        get: (key: string) => {
            if (key === 'id') return id
            if (key === 'privateKey') return privateKey
            if (key === 'threshold') return 2
            if (key === 'nodes') return nodesConfig
            if (key === 'networkPublicKeys')
                return Object.fromEntries(Object.entries(mockData).map(([k, v]) => [k, v.getPublic('hex')]))
            return null
        },
    } as ConfigService

    const nodeHttpService = {
        get: jest.fn().mockImplementation((url: string, config: any) => {
            if (url.includes('fund/latest-state')) {
                const uidHex = (config.params.userId || '').replace('0x', '').padStart(40, '0')
                const smt = new SMT()
                return of({
                    data: {
                        nonce: 0,
                        root: smt.getRoot(),
                        signature: null,
                        oldBalance: '0',
                        merkleProof: smt.prove(uidHex),
                    },
                })
            }
        }),
        post: jest.fn().mockImplementation((url: string, data: any) => {
            networkQueue.push({ url, data })
            return of({ data: { success: true } })
        }),
    } as any

    const keyModel = new MockModel() as any
    const shareModel = new MockModel() as any
    const tssStateModel = new MockModel() as any
    const pendingTransactionModel = new MockModel() as any
    const fundModel = new MockModel() as any
    
    // FundService mock to capture commit
    fundModel.commitTransaction = jest.fn().mockResolvedValue(true)
    const fundService = new FundService(fundModel as any)
    
    const dkgService = new DkgService(keyModel, shareModel, config, nodeHttpService)
    const tssService = new TssService(
        keyModel,
        shareModel,
        tssStateModel,
        pendingTransactionModel,
        config,
        nodeHttpService,
        fundService
    )
    return { id, dkgService, tssService, fundService, keyModel, tssStateModel, pendingTransactionModel, nodeHttpService }
}

const networkQueue: { url: string; data: any }[] = []

describe('Threshold Signature Scheme P2P (n=3, t=2)', () => {
    const n = 3, t = 2
    const subsetIds = [1, 2]
    const chainId = '1'
    const userId = '1234567890123456789012345678901234567890'
    const amount = '100'

    let nodes: ReturnType<typeof createMock>[] = []
    let Y_Public: string
    let sharedMessageHash: string

    const routePhaseRequests = async (endpoint: string) => {
        let routed = false
        const remainingQueue: typeof networkQueue = []
        
        while (networkQueue.length > 0) {
            const req = networkQueue.shift()!
            
            if (req.url.includes(endpoint)) {
                const destNode = nodes.find(n => req.url.startsWith(`http://localhost:300${n.id}`))
                if (destNode) {
                    routed = true
                    if (req.url.includes('/tss/start')) await destNode.tssService.tssStart(req.data.i, req.data.messageHash, req.data.payload, false, req.data.E_k, req.data.E_x, req.data.Gamma)
                    else if (req.url.includes('/tss/mta')) await destNode.tssService.tssMta(req.data.messageHash, req.data.from, req.data.alpha, req.data.nu)
                    else if (req.url.includes('/tss/delta')) await destNode.tssService.tssDelta(req.data.messageHash, req.data.from, req.data.delta)
                    else if (req.url.includes('/tss/sign')) await destNode.tssService.tssSign(req.data.messageHash, req.data.from, req.data.s_i)
                }
            } else {
                remainingQueue.push(req)
            }
        }
        
        networkQueue.push(...remainingQueue)
        
        if (routed) {
            await routePhaseRequests(endpoint)
        }
    }

    beforeAll(async () => {
        nodes = [createMock(1), createMock(2), createMock(3)]

        const bData = []
        for (const node of nodes) bData.push({ id: node.id, ...(await node.dkgService.broadcastDkgShares(t, n)) })
        const fcAll = []
        for (const receiver of nodes) {
            const batchedShares: any[] = []
            for (const sender of bData) {
                const share = sender.data.find((x: any) => x.j === receiver.id)
                batchedShares.push({ i: sender.id, encryptedPayload: share.encryptedPayload, commitments: sender.commitments })
            }
            fcAll.push((await receiver.dkgService.receiveDkgShares(batchedShares)).feldmanCommitments)
        }
        for (const node of nodes) await node.dkgService.computePublicKey(fcAll)
        
        const keyDoc = await nodes[0].keyModel.findOne({})
        Y_Public = keyDoc.Y
    })

    it('Phase 0 & 1: Nodes propose transaction and process Start Phase', async () => {
        const hashes: string[] = []

        // 1. Propose transaction
        for (const id of subsetIds) {
            const node = nodes[id - 1]
            const res = await node.tssService.proposeTransaction(chainId, userId, amount)
            hashes.push(res.messageHash)
            
            const pending = await node.pendingTransactionModel.findOne({ chainId })
            expect(pending).toBeDefined()
        }
        expect(hashes[0]).toEqual(hashes[1])
        sharedMessageHash = hashes[0]

        // 2. Network routing for Phase 1
        await routePhaseRequests('/tss/start')

        for (const id of subsetIds) {
            const node = nodes[id - 1]
            const tssState = await node.tssStateModel.findOne({ messageHash: sharedMessageHash })
            expect(tssState.starts.length).toBe(t)
            expect(tssState.k_i).toBeDefined()
            expect(tssState.w_i).toBeDefined() // Transition to MtA sets w_i
        }
    })

    it('Phase 2: MtA round 1 & 2', async () => {
        await routePhaseRequests('/tss/mta')

        for (const id of subsetIds) {
            const node = nodes[id - 1]
            const tssState = await node.tssStateModel.findOne({ messageHash: sharedMessageHash })
            expect(tssState.mtas.length).toBe(t - 1)
            expect(tssState.sigma_i).toBeDefined() // Transition to Delta sets sigma_i
        }
    })

    it('Phase 3: Delta + Sigma', async () => {
        await routePhaseRequests('/tss/delta')

        for (const id of subsetIds) {
            const node = nodes[id - 1]
            const tssState = await node.tssStateModel.findOne({ messageHash: sharedMessageHash })
            expect(tssState.deltas.length).toBe(t)
            expect(tssState.r).toBeDefined() // Transition to Sign sets r
        }
    })

    it('Phase 4: Distributed ECDSA signature and state commit', async () => {
        await routePhaseRequests('/tss/sign')

        for (const id of subsetIds) {
            const node = nodes[id - 1]
            const dbKey = await node.keyModel.findOne({})

            expect(dbKey.chains[chainId].nonce).toBe(1)
            expect(dbKey.chains[chainId].root).toBeDefined()

            // Verify temporary states are cleaned up
            const pendingTx = await node.pendingTransactionModel.findOne({ messageHash: sharedMessageHash })
            expect(pendingTx).toBeNull()

            const tssState = await node.tssStateModel.findOne({ messageHash: sharedMessageHash })
            expect(tssState).toBeNull()

            // Verify the generated ECDSA signature is mathematically valid!
            const fundState = await node.fundService.getSettlementData(chainId)
            expect(fundState).toBeDefined()
            
            const key = C.secp256k1.keyFromPublic(Y_Public, 'hex')
            const isValid = key.verify(sharedMessageHash, { 
                r: fundState.signature.r, 
                s: fundState.signature.s 
            })
            expect(isValid).toBe(true)
        }
    })
})
