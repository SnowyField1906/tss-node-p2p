import { HttpModule } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

import configuration from '@config'
import { DkgController, FundController, PingController, TssController } from '@controllers'
import {
    Fund,
    FundSchema,
    Key,
    KeySchema,
    PendingTransaction,
    PendingTransactionSchema,
    Proposal,
    ProposalSchema,
    Share,
    ShareSchema,
    TssState,
    TssStateSchema,
} from '@schemas'
import { DkgService, FundService, PingService, TssService } from '@services'

@Module({
    imports: [
        HttpModule,
        ConfigModule.forRoot({
            load: [configuration as any],
        }),
        MongooseModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: async (configService: ConfigService) => {
                return {
                    uri: configService.get<string>('mongoUri'),
                }
            },
            inject: [ConfigService],
        }),
        MongooseModule.forFeature([
            { name: Key.name, schema: KeySchema },
            { name: Share.name, schema: ShareSchema },
            { name: TssState.name, schema: TssStateSchema },
            { name: PendingTransaction.name, schema: PendingTransactionSchema },
            { name: Fund.name, schema: FundSchema },
            { name: Proposal.name, schema: ProposalSchema },
        ]),
        ConfigModule,
    ],
    controllers: [DkgController, FundController, PingController, TssController],
    providers: [DkgService, FundService, PingService, TssService],
})
export class AppModule {}
