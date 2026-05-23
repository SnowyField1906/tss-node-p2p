import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type FundDocument = HydratedDocument<Fund>

@Schema({ timestamps: true })
export class Fund {
    @Prop({ required: true, unique: true })
    chainId: string

    @Prop({ required: true, default: 0 })
    nonce: number

    @Prop({ required: true })
    root: string

    @Prop({ type: Object, default: null })
    signature: { r: string; s: string } | null

    @Prop({ type: Object, default: {} })
    balances: {
        [userId: string]: string
    }
}

export const FundSchema = SchemaFactory.createForClass(Fund)
