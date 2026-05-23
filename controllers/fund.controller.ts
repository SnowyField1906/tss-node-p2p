import { Body, Controller, Get, Post, Query } from '@nestjs/common'

import {
    FundProposeRequest,
    FundProposeResponse,
    GetLatestStateResponse,
    GetMerkleProofResponse,
    GetSettlementDataResponse,
} from '@dtos'
import { FundService, TssService } from '@services'

@Controller('fund')
export class FundController {
    constructor(
        private readonly fundService: FundService,
        private readonly tssService: TssService
    ) {}

    @Get('latest-state')
    async getLatestState(@Query('chainId') chainId: string, @Query('userId') userId: string) {
        return await this.fundService.getLatestState(chainId, userId)
    }

    @Post('propose')
    async proposeTransaction(@Body() data: FundProposeRequest): Promise<FundProposeResponse> {
        return await this.tssService.receiveProposal(data.i, data.messageHash, data.payload)
    }

    @Get('proof')
    async getMerkleProof(@Query('chainId') chainId: string, @Query('userId') userId: string) {
        return await this.fundService.getMerkleProof(chainId, userId).then((res) => ({
            balance: `0x${res.balance}`,
            proof: res.proof.map((p) => `0x${p}`),
        }))
    }

    @Get('settlement-data')
    async getSettlementData(@Query('chainId') chainId: string) {
        const res = await this.fundService.getSettlementData(chainId)
        if (!res) return null
        return {
            root: `0x${res.root}`,
            nonce: res.nonce,
            signature: {
                r: `0x${res.signature.r}`,
                s: `0x${res.signature.s}`,
            },
        }
    }
}
