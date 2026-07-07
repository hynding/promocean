export default ({ env }: { env: any }) => ({
  connection: {
    client: 'postgres',
    connection: { connectionString: env('DATABASE_URL') },
    pool: { min: 0, max: 10 },
  },
})
