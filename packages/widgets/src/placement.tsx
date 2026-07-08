import { useEffect, useState } from 'react'
import type { OfferCreative } from '@promocean/contracts'
import { usePromocean } from './provider.js'

function safeHttpUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

export function Placement({ slug }: { slug: string }) {
  const client = usePromocean()
  const [offer, setOffer] = useState<OfferCreative | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    client.getPlacementOffer(slug)
      .then((o) => {
        if (cancelled) return
        setOffer(o)
        if (o && !client.isOfferDismissed(o.offerId)) void client.recordImpression(o.offerId)
      })
      .catch(() => {}) // fail silent-to-empty
    return () => { cancelled = true }
  }, [client, slug])

  if (!offer || dismissed || client.isOfferDismissed(offer.offerId)) return null

  const ctaUrl = safeHttpUrl(offer.ctaUrl)
  const imageUrl = safeHttpUrl(offer.imageUrl)

  return (
    <div data-promocean-placement={slug}
         style={{ position: 'relative', border: '1px solid #ddd', borderRadius: 8, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <button aria-label="Dismiss offer"
              onClick={() => { client.dismissOffer(offer.offerId); setDismissed(true) }}
              style={{ position: 'absolute', top: 8, right: 8, border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 }}>
        ×
      </button>
      {imageUrl ? <img src={imageUrl} alt="" style={{ maxWidth: '100%', borderRadius: 4 }} /> : null}
      <div style={{ fontWeight: 600 }}>{offer.headline}</div>
      {offer.body ? <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>{offer.body}</div> : null}
      {ctaUrl ? (
        <a href={ctaUrl} target="_blank" rel="noopener noreferrer"
           onClick={() => { void client.clickOffer(offer.offerId) }}
           style={{ display: 'inline-block', marginTop: 8, fontWeight: 600 }}>
          {offer.ctaText ?? 'Learn more'}
        </a>
      ) : null}
    </div>
  )
}
