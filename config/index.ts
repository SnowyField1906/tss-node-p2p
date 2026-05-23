import * as dotenv from 'dotenv'

const isLocal = process.env.NODE_ENV === 'local'
dotenv.config({ path: isLocal ? `node-${process.env.NODE_ID}.env.local` : '.env' })

export default () => ({
    id: Number(process.env.NODE_ID),
    host: process.env.HOST,
    port: process.env.PORT,
    mongoUri: process.env.MONGO_URI,
    privateKey: process.env.PRIVATE_KEY,
    threshold: Number(process.env.THRESHOLD),
    networkPublicKeys: Array.from({ length: Number(process.env.SIZE) }).reduce(
        (acc, _, i) => {
            acc[i + 1] = process.env[`NODE_${i + 1}_PUBLIC_KEY`]
            return acc
        },
        {} as Record<number, string>
    ),
    nodes: Array.from({ length: Number(process.env.SIZE) }, (_, i) => ({
        id: i + 1,
        url: process.env[`NODE_${i + 1}_URL`],
    })),
})
