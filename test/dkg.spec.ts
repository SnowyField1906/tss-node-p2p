import { ConfigService } from '@nestjs/config'
import { of } from 'rxjs'

import { BN, C } from '@common'
import { DkgService } from '@services/dkg.service'

const mockData = {
    1: C.generateKeyPair(),
    2: C.generateKeyPair(),
    3: C.generateKeyPair(),
}

class MockModel {
    private data: any[] = []

    async create(doc: any) {
        this.data.push(doc)
    }

    async deleteMany(query: any = {}) {
        this.data = []
        return { acknowledged: true, deletedCount: this.data.length }
    }
    async findOne(query: any = {}) {
        return this.data.find((item) => Object.keys(query).every((k) => item[k] === query[k])) || null
    }
    async find(query: any = {}) {
        return this.data.filter((item) => Object.keys(query).every((k) => item[k] === query[k]))
    }
    async updateOne(query: any = {}, updateData: any = {}, options: any = {}) {
        const update = updateData.$set || updateData
        const index = this.data.findIndex((item) => Object.keys(query).every((k) => item[k] === query[k]))
        if (index > -1) this.data[index] = { ...this.data[index], ...update }
        else if (options.upsert) this.data.push({ ...query, ...update })
    }

    async findOneAndUpdate(query: any = {}, updateData: any = {}, options: any = {}) {
        const { $set, $addToSet, $setOnInsert, ...plainFields } = updateData
        const update = { ...(plainFields || {}), ...($set || {}) }
        const addToSet = $addToSet || {}

        let index = this.data.findIndex((item) =>
            Object.keys(query).every((k) => {
                if (query[k] && typeof query[k] === 'object' && '$exists' in query[k]) {
                    const exists = query[k].$exists
                    return exists ? item[k] !== undefined : item[k] === undefined
                }
                if (query[k] && typeof query[k] === 'object' && '$ne' in query[k]) {
                    return item[k] !== query[k].$ne
                }
                return item[k] === query[k]
            })
        )

        if (index === -1 && options.upsert) {
            const newItem: any = { ...query, ...($setOnInsert || {}) }
            Object.assign(newItem, update)
            for (const [key, val] of Object.entries(addToSet)) {
                newItem[key] = [val]
            }
            this.data.push(newItem)
            index = this.data.length - 1
        } else if (index > -1) {
            Object.assign(this.data[index], update)
            for (const [key, val] of Object.entries(addToSet)) {
                if (!this.data[index][key]) this.data[index][key] = []
                const exists = this.data[index][key].find((x: any) => JSON.stringify(x) === JSON.stringify(val))
                if (!exists) this.data[index][key].push(val)
            }
        }

        if (index > -1) {
            return options.new ? this.data[index] : null
        }
        return null
    }

    async findOneAndDelete(query: any = {}) {
        const index = this.data.findIndex((item) => Object.keys(query).every((k) => item[k] === query[k]))
        if (index > -1) {
            const item = this.data[index]
            this.data.splice(index, 1)
            return item
        }
        return null
    }
}

const networkQueue: { url: string; data: any }[] = []

const createMock = (id: number) => {
    const privateKey = mockData[id as keyof typeof mockData].getPrivate('hex')
    const nodes = [
        { id: 1, url: 'http://localhost:3001' },
        { id: 2, url: 'http://localhost:3002' },
        { id: 3, url: 'http://localhost:3003' },
    ]
    const config = {
        get: (key: string) => {
            if (key === 'id') return id
            if (key === 'privateKey') return privateKey
            if (key === 'threshold') return 2
            if (key === 'nodes') return nodes
            if (key === 'networkPublicKeys')
                return Object.fromEntries(Object.entries(mockData).map(([k, v]) => [k, v.getPublic('hex')]))
            return null
        },
    } as ConfigService

    const nodeHttpService = {
        post: jest.fn().mockImplementation((url: string, data: any) => {
            networkQueue.push({ url, data })
            return of({ data: { success: true } })
        }),
    } as any

    const keyModel = new MockModel() as any
    const shareModel = new MockModel() as any
    const dkgStateModel = new MockModel() as any
    const dkgService = new DkgService(keyModel, shareModel, dkgStateModel, config, nodeHttpService)

    return { id, dkgService, keyModel, shareModel, dkgStateModel, nodeHttpService }
}

describe('Distributed Key Generation P2P Mesh (n=3, t=2)', () => {
    const n = 3,
        t = 2

    let nodes: ReturnType<typeof createMock>[] = []

    const routePhaseRequests = async (endpoint: string) => {
        let routed = false
        const remainingQueue: typeof networkQueue = []

        while (networkQueue.length > 0) {
            const req = networkQueue.shift()!

            if (req.url.includes(endpoint)) {
                const destNode = nodes.find((n) => req.url.startsWith(`http://localhost:300${n.id}`))
                if (destNode) {
                    routed = true
                    if (req.url.includes('/dkg/broadcast')) {
                        await destNode.dkgService.broadcastDkgShares()
                    } else if (req.url.includes('/dkg/receive')) {
                        await destNode.dkgService.receiveDkgShares(req.data)
                    } else if (req.url.includes('/dkg/compute-public-key')) {
                        await destNode.dkgService.computePublicKey(req.data)
                    }
                }
            } else {
                remainingQueue.push(req)
            }
        }

        networkQueue.push(...remainingQueue)

        if (routed) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            await routePhaseRequests(endpoint)
        } else {
            let attempts = 0
            while (attempts < 20) {
                await new Promise((resolve) => setTimeout(resolve, 50))
                if (networkQueue.some((r) => r.url.includes(endpoint))) {
                    await routePhaseRequests(endpoint)
                    return
                }
                attempts++
            }
        }
    }

    beforeAll(() => {
        nodes = [createMock(1), createMock(2), createMock(3)]
        networkQueue.length = 0
    })

    it('Phase 0 & 1: Client triggers DKG broadcast on all nodes', async () => {
        // Client triggers DKG independently on all nodes
        await Promise.all(nodes.map((node) => node.dkgService.broadcastDkgShares()))

        // At this point, nodes have populated their keyModel with f_poly and created dkgStateModel
        for (const node of nodes) {
            const keyDoc = await node.keyModel.findOne({})
            expect(keyDoc).toBeDefined()
            expect(keyDoc.f_poly.length).toBe(t)
        }
    })

    it('Phase 2: Nodes receive shares (P2P), verify, and transition to Feldman', async () => {
        await routePhaseRequests('/dkg/receive')

        for (const node of nodes) {
            const dkgState = await node.dkgStateModel.findOne({})
            expect(dkgState.shares.length).toBe(n)
            expect(dkgState.x_i).toBeDefined()
            expect(dkgState.x_i).not.toBe('0')
            expect(dkgState.x_i).not.toBe('processing')

            const savedShares = await node.shareModel.find()
            expect(savedShares.length).toBe(n)
        }
    })

    it('Phase 3: Nodes receive Feldman commitments and compute final Public Key', async () => {
        await routePhaseRequests('/dkg/compute-public-key')

        const keyDoc1 = await nodes[0].keyModel.findOne({})
        const Y = keyDoc1.Y
        expect(Y).toBeDefined()

        for (const node of nodes) {
            const dkgState = await node.dkgStateModel.findOne({})
            expect(dkgState).toBeNull()

            const doc = await node.keyModel.findOne({})
            expect(doc.Y).toBe(Y)
        }

        const subset = [1, 2]
        let reconstructedSecret = BN.ZERO

        for (const i of subset) {
            const keyDoc = await nodes[i - 1].keyModel.findOne({})
            const x_i = BN.from(keyDoc.x_i)
            let lambda = BN.ONE
            for (const j of subset) {
                if (i === j) continue
                const top = BN.from(j).neg().umod(C.ORDER)
                const bottom = BN.from(i).sub(BN.from(j)).umod(C.ORDER)
                lambda = lambda.mul(top.mul(bottom.invm(C.ORDER))).umod(C.ORDER)
            }
            reconstructedSecret = reconstructedSecret.add(x_i.mul(lambda)).umod(C.ORDER)
        }

        const Y_reconstructed = C.secp256k1.curve.g.mul(reconstructedSecret)
        expect(Y_reconstructed.encode('hex', false)).toBe(Y)
    })
})
