import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type TssStateDocument = HydratedDocument<TssState>

@Schema({ timestamps: true })
export class TssState {
    @Prop({ required: true, unique: true })
    messageHash: string

    @Prop({ type: Object })
    payload: any

    @Prop({ required: false })
    k_i: string

    @Prop({ required: false })
    gamma_i: string

    @Prop({ required: false })
    w_i: string

    @Prop({ required: false })
    sigma_i: string

    @Prop({ type: Object, default: {} })
    betas: { [toNodeId: string]: string }

    @Prop({ type: Object, default: {} })
    mus: { [toNodeId: string]: string }

    @Prop({ type: Array, default: [] })
    starts: any[]

    @Prop({ type: Array, default: [] })
    mtas: any[]

    @Prop({ type: Array, default: [] })
    deltas: any[]

    @Prop({ type: Array, default: [] })
    signs: any[]

    @Prop({ required: false })
    r: string
}

export const TssStateSchema = SchemaFactory.createForClass(TssState)
