export class TssProposeRequest {
    chainId: string
    userId: string
    amount: string
}
export class TssProposeResponse {
    messageHash: string
}

export class TssStartRequest {
    i: number
    messageHash: string
    E_k: string
    E_x: string
    Gamma: string
}
export class TssStartResponse {
    status: string
}

export class TssMtaRequest {
    messageHash: string
    from: number
    alpha: string
    nu: string
}
export class TssMtaResponse {
    status: string
}

export class TssDeltaRequest {
    messageHash: string
    from: number
    delta: string
}
export class TssDeltaResponse {
    status: string
}

export class TssSignRequest {
    messageHash: string
    from: number
    s_i: string
}
export class TssSignResponse {
    status: string
}
