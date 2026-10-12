# dirac.digital

The domain stays registered at Porkbun. Cloudflare manages DNS, HTTPS, and the existing `dirac` Worker. This is a Workers Custom Domain setup.

## Activate the domain

1. Add `dirac.digital` as a website/zone in the same Cloudflare account that owns the `dirac` Worker. The Free zone plan is sufficient for this setup.
2. Review imported DNS records. Preserve any mail records (MX, SPF, DKIM, DMARC) if mail is configured. Remove only parking records for the website host that conflict with the Worker domain.
3. Copy the two nameservers Cloudflare assigns to this zone.
4. In Porkbun: **Account > Domain Management > dirac.digital > Details > Nameservers > edit**. Replace the existing nameservers with those two names, one per line, and save. If DNSSEC is enabled, disable it before the change; re-enable it with Cloudflare's settings after activation.
5. Wait until the Cloudflare zone reports **Active**. Porkbun says global propagation can take up to 48 hours.
6. From this project directory, run `npm run deploy`. The `routes` entry in `wrangler.jsonc` attaches `dirac.digital` to the existing Worker; Cloudflare creates its DNS record and HTTPS certificate. A Custom Domain cannot be added on a hostname with an existing CNAME, so clear conflicting parking records first.

Alternatively, attach the domain through **Workers & Pages > dirac > Settings > Domains & Routes > Add > Custom Domain**. Keep the matching `routes` configuration in this repository for subsequent deployments.

## Application configuration

- `wrangler.jsonc`: Custom Domain `dirac.digital`, `SITE_URL=https://dirac.digital`, and `workers_dev=true` to retain the old address during the transition. Existing D1 bindings, secrets, and cron configuration belong to the same Worker.
- Next.js metadata, the default Open Graph image, badge/share fallback URLs, and X post URLs use the new domain.
- Production `NEXT_PUBLIC_API_BASE` must be unset or empty. The browser calls `/api/*` on the same domain; the production CSP allows same-origin connections. Do not copy the development API override into production.
- `NEXT_PUBLIC_SITE_URL` is optional; metadata defaults to `https://dirac.digital`, while browser share links use the current origin. If set for a production build, use `https://dirac.digital`. Next.js embeds public variables at build time, so rebuild after changing them.
- `.env.development.local` can keep the old Worker API until the new domain works. Afterwards, its `NEXT_PUBLIC_API_BASE` can be changed to `https://dirac.digital` if desired.
- `www.dirac.digital` is not attached by this configuration. If needed, add it separately and configure a Cloudflare redirect to `https://dirac.digital`, preserving path and query.

## Verify after deployment

Open `/`, `/scan`, `/passport`, and `/pet` on `https://dirac.digital`. Check wallet connection, an API read, a valid public passport's badge, share links, and Open Graph/canonical URLs. Check `/actions.json` and an invite Action using a real wallet address. Confirm the old Worker address still works.

Browser storage is separate for each origin. Reconnect the wallet on the new domain. Restore a simple passport using its wallet signature; restore a hardened passport with its recovery phrase or recovery file. The v1 derivation message in `src/lib/pq.ts` contains the historical `dirac.network` name and must stay byte-for-byte unchanged: changing that message changes the derived keys and breaks recovery of existing simple passports. A future message change needs an explicit versioned migration.

After the new domain has been verified and passport recovery has been checked, a separate change can redirect the old website address. Keep the API available while old clients and links are in use. Update external profile links and submit the new domain to the Blink registry separately if Blink registration is needed.

## References

- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare nameserver setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Porkbun: change nameservers](https://kb.porkbun.com/article/22-how-to-change-nameservers)
