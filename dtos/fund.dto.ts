export class GetLatestStateResponse {
    nonce: number
    root: string
    signature: { r: string; s: string } | null
    oldBalance: string
    merkleProof: string[]
}

export class GetMerkleProofResponse {
    balance: string
    proof: string[]
}
export class GetSettlementDataResponse {
    root: string
    nonce: number
    signature: { r: string; s: string } | null
}

export class FundProposeRequest {
    i: number
    messageHash: string
    payload: any // using any or TxPayload
}

export class FundProposeResponse {
    status: string
}
