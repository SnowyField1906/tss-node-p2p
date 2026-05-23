export class ReceiveDkgDataRequest {
    from: number
    encryptedPayload: Ecies
    commitments: string[]
}

export class ReceiveDkgDataResponse {
    status: string
}

export class ComputePublicKeyRequest {
    from: number
    feldmanCommitments: string[]
}

export class ComputePublicKeyResponse {
    status: string
}

export class BroadcastDkgResponse {
    success: boolean
}
