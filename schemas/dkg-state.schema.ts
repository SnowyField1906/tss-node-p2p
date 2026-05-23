import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type DkgStateDocument = HydratedDocument<DkgState>

@Schema({ timestamps: true })
export class DkgState {
    @Prop({ type: Array, default: [] })
    shares: any[]

    @Prop({ type: Array, default: [] })
    feldmans: any[]

    @Prop({ required: false })
    x_i: string
}

export const DkgStateSchema = SchemaFactory.createForClass(DkgState)
