import { Body, Controller, Get, Post, Query } from '@nestjs/common'

import { FundCommitRequest } from '@dtos'
import { FundService } from '@services'

@Controller('fund')
export class FundController {
    constructor(private readonly fundService: FundService) {}

    @Get('latest-state')
    async getLatestState(
        @Query('chainId') chainId: string,
        @Query('userId') userId: string
    ) {
        return await this.fundService.getLatestState(chainId, userId)
    }

    @Get('proof')
    async getMerkleProof(
        @Query('chainId') chainId: string,
        @Query('userId') userId: string
    ) {
        return await this.fundService
            .getMerkleProof(chainId, userId)
            .then((res) => ({
                balance: `0x${res.balance}`,
                proof: res.proof.map((p) => `0x${p}`),
            }))
    }

    @Get('settlement-data')
    async getSettlementData(
        @Query('chainId') chainId: string
    ) {
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

    @Post('commit')
    async commit(@Body() data: FundCommitRequest) {
        await this.fundService.commitTransaction(data.payload, data.signature)
        return { success: true }
    }
}
