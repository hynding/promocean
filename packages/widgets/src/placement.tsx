import { useEffect, useState } from 'react'
import type { OfferCreative } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function Placement({ slug }: { slug: string }) {
  const client = usePromocean()
  const [offer, setOffer] = useState<OfferCreative | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    client.getPlacementOffer(slug)
      .then((o) => { if (!cancelled) setOffer(o) })
      .catch(() => {}) // fail silent-to-empty
    return () => { cancelled = true }
  }, [client, slug])

  if (!offer || dismissed || client.isOfferDismissed(offer.offerId)) return null

  return (
    <div data-promocean-placement={slug}
         style={{ position: 'relative', border: '1px solid #ddd', borderRadius: 8, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <button aria-label="Dismiss offer"
              onClick={() => { client.dismissOffer(offer.offerId); setDismissed(true) }}
              style={{ position: 'absolute', top: 8, right: 8, border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 }}>
        ×
      </button>
      {offer.imageUrl ? <img src={offer.imageUrl} alt="" style={{ maxWidth: '100%', borderRadius: 4 }} /> : null}
      <div style={{ fontWeight: 600 }}>{offer.headline}</div>
      {offer.body ? <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>{offer.body}</div> : null}
      {offer.ctaUrl ? (
        <a href={offer.ctaUrl} target="_blank" rel="noopener noreferrer"
           onClick={() => { void client.clickOffer(offer.offerId) }}
           style={{ display: 'inline-block', marginTop: 8, fontWeight: 600 }}>
          {offer.ctaText ?? 'Learn more'}
        </a>
      ) : null}
    </div>
  )
}
