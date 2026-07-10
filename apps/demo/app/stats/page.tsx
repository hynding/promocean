import { Promocean } from '@promocean/sdk'
import { BackfillForm } from './backfill-form'
import { CouponCheckForm } from './coupon-check-form'

// Server component only: reads process.env.PROMOCEAN_SECRET_KEY (never
// NEXT_PUBLIC_*, which would ship the secret key to the browser bundle).
// `force-dynamic` disables static rendering/caching so every request
// reflects the current aggregates.
export const dynamic = 'force-dynamic'

export default async function StatsPage() {
  const client = new Promocean({
    publishableKey: '',
    secretKey: process.env.PROMOCEAN_SECRET_KEY!,
    baseUrl: process.env.PROMOCEAN_API_URL ?? process.env.NEXT_PUBLIC_PROMOCEAN_API!,
  })
  const stats = await client.getStats()

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Promocean Stats</h1>
      <p style={{ color: '#666', fontSize: 14 }}>
        Range: {stats.range.from ?? 'all time'} &ndash; {stats.range.to ?? 'now'}
      </p>

      <section data-testid="stats-totals">
        <h2>Totals</h2>
        <ul>
          <li>Events: <strong data-testid="stats-total-events">{stats.totals.events}</strong></li>
          <li>Unlocks: <strong data-testid="stats-total-unlocks">{stats.totals.unlocks}</strong></li>
          <li>Impressions: <strong data-testid="stats-total-impressions">{stats.totals.impressions}</strong></li>
          <li>Clicks: <strong data-testid="stats-total-clicks">{stats.totals.clicks}</strong></li>
          <li>Timed-event participants: <strong data-testid="stats-total-timed-event-participants">{stats.totals.timedEventParticipants}</strong></li>
        </ul>
      </section>

      <section>
        <h2>Achievements</h2>
        <table data-testid="stats-achievements">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Achievement ID</th><th style={{ textAlign: 'left' }}>Unlocks</th></tr>
          </thead>
          <tbody>
            {stats.achievements.map((a) => (
              <tr key={a.achievementId} data-testid={`stats-achievement-row-${a.achievementId}`}>
                <td>{a.achievementId}</td>
                <td data-testid={`stats-achievement-unlocks-${a.achievementId}`}>{a.unlocks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Offers</h2>
        <table data-testid="stats-offers">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Offer ID</th>
              <th style={{ textAlign: 'left' }}>Impressions</th>
              <th style={{ textAlign: 'left' }}>Clicks</th>
              <th style={{ textAlign: 'left' }}>CTR</th>
            </tr>
          </thead>
          <tbody>
            {stats.offers.map((o) => (
              <tr key={o.offerId} data-testid={`stats-offer-row-${o.offerId}`}>
                <td>{o.offerId}</td>
                <td data-testid={`stats-offer-impressions-${o.offerId}`}>{o.impressions}</td>
                <td data-testid={`stats-offer-clicks-${o.offerId}`}>{o.clicks}</td>
                <td>{o.ctr === null ? '—' : `${(o.ctr * 100).toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Timed events</h2>
        <table data-testid="stats-timed-events">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Event</th><th style={{ textAlign: 'left' }}>Participants</th></tr>
          </thead>
          <tbody>
            {stats.timedEvents.map((e) => (
              <tr key={e.eventId} data-testid={`stats-timed-event-row-${e.eventId}`}>
                <td>{e.name}</td>
                <td data-testid={`stats-timed-event-participants-${e.eventId}`}>{e.participants}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <CouponCheckForm />
      <BackfillForm />
    </main>
  )
}
