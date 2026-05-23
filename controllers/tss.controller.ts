import { Body, Controller, Post } from '@nestjs/common'

import {
    TssDeltaRequest,
    TssDeltaResponse,
    TssMtaRequest,
    TssMtaResponse,
    TssProposeRequest,
    TssProposeResponse,
    TssSignRequest,
    TssSignResponse,
    TssStartRequest,
    TssStartResponse,
} from '@dtos'
import { TssService } from '@services'

@Controller('tss')
export class TssController {
    constructor(private readonly tssService: TssService) {}

    @Post('propose')
    async tssPropose(@Body() data: TssProposeRequest): Promise<TssProposeResponse> {
        return await this.tssService.proposeTransaction(data.chainId, data.userId, data.amount)
    }

    @Post('start')
    async tssStart(@Body() data: TssStartRequest): Promise<TssStartResponse> {
        return await this.tssService.tssStart(
            data.i,
            data.messageHash,
            data.E_k,
            data.E_x,
            data.Gamma
        )
    }

    @Post('mta')
    async tssMta(@Body() data: TssMtaRequest): Promise<TssMtaResponse> {
        return await this.tssService.tssMta(data.messageHash, data.from, data.alpha, data.nu)
    }

    @Post('delta')
    async tssDelta(@Body() data: TssDeltaRequest): Promise<TssDeltaResponse> {
        return await this.tssService.tssDelta(data.messageHash, data.from, data.delta)
    }

    @Post('sign')
    async tssSign(@Body() data: TssSignRequest): Promise<TssSignResponse> {
        return await this.tssService.tssSign(data.messageHash, data.from, data.s_i)
    }
}
