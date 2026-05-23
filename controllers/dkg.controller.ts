import { Body, Controller, Post } from '@nestjs/common'

import { ComputePublicKeyRequest, ComputePublicKeyResponse, ReceiveDkgDataRequest, ReceiveDkgDataResponse } from '@dtos'
import { DkgService } from '@services'

@Controller('dkg')
export class DkgController {
    constructor(private readonly dkgService: DkgService) {}

    @Post('broadcast')
    async broadcastDkgShares() {
        return await this.dkgService.broadcastDkgShares()
    }

    @Post('receive')
    async receiveDkgShares(@Body() data: ReceiveDkgDataRequest): Promise<ReceiveDkgDataResponse> {
        return await this.dkgService.receiveDkgShares(data)
    }

    @Post('compute-public-key')
    async computePublicKey(@Body() data: ComputePublicKeyRequest): Promise<ComputePublicKeyResponse> {
        return await this.dkgService.computePublicKey(data)
    }
}
