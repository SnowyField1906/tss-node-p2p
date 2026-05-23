import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type ProposalDocument = HydratedDocument<Proposal>

@Schema({ timestamps: true })
export class Proposal {
    @Prop({ required: true, unique: true })
    messageHash: string

    @Prop({ required: true })
    chainId: string

    @Prop({ type: Object, required: true })
    payload: TxPayload

    @Prop({ type: [Number], default: [] })
    proposers: number[]
}

export const ProposalSchema = SchemaFactory.createForClass(Proposal)
