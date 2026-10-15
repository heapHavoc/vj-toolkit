# Common Shopify third parties

Use this to turn a script domain into an app name and purpose, and as search terms when tracing how a script is loaded. It is a lookup aid, not a list to report: only apps that appear in the page's own data go in a report. If a domain isn't listed, name it by its domain and say what the script appears to do.

| Domain / file pattern | App or vendor | Purpose | Usually loaded via |
|---|---|---|---|
| `googletagmanager.com/gtm.js` | Google Tag Manager | Tag container (loads other tags) | Theme code or app embed |
| `googletagmanager.com/gtag/js`, `google-analytics.com` | Google Analytics 4 / Google Ads | Analytics, ad conversions | Google & YouTube app (Customer Events) or GTM |
| `connect.facebook.net`, `fbevents.js` | Meta Pixel | Ad tracking | Facebook & Instagram app (Customer Events) or GTM |
| `analytics.tiktok.com` | TikTok Pixel | Ad tracking | TikTok app or GTM |
| `snap.licdn.com`, `ct.pinterest.com`, `sc-static.net` | LinkedIn / Pinterest / Snapchat pixels | Ad tracking | App or GTM |
| `clarity.ms` | Microsoft Clarity | Session recording | Theme code or GTM |
| `static.hotjar.com` | Hotjar | Session recording, heatmaps | Theme code or GTM |
| `static.klaviyo.com`, `klaviyo.js` | Klaviyo | Email/SMS sign-up forms, tracking | App embed |
| `cdn.judge.me`, `judge.me` | Judge.me | Product reviews | App embed / app blocks |
| `staticw2.yotpo.com`, `cdn-widgetsrepository.yotpo.com` | Yotpo | Reviews, loyalty | App embed / app blocks |
| `okendo.io` | Okendo | Reviews | App embed / app blocks |
| `loox.io` | Loox | Photo reviews | App embed / app blocks |
| `stamped.io` | Stamped | Reviews | App embed |
| `rebuyengine.com` | Rebuy | Upsell / recommendations | App embed / app blocks |
| `getflits.com`, `flits` | Flits | Loyalty, customer accounts | App embed |
| `uppromote.com`, `secomapp` | UpPromote | Affiliates | App embed |
| `gokwik.co`, `gokwik` | GoKwik | Checkout, COD, OTP login | App embed / theme code |
| `shopflo.co` | Shopflo | Checkout | App embed |
| `razorpay.com/magic`, `checkout.razorpay.com` | Razorpay Magic Checkout | Checkout | App embed / theme code |
| `gorgias.chat`, `config.gorgias.chat` | Gorgias | Support chat | App embed |
| `widget.tidio.co`, `code.tidio.co` | Tidio | Chat | App embed |
| `widget.intercom.io`, `js.intercomcdn.com` | Intercom | Chat | Theme code / GTM |
| `wa.me`, `whatsapp` widgets | WhatsApp chat buttons | Chat | App embed |
| `cdn.shopify.com/extensions/…` | A Shopify app's theme extension | Depends on the app (path names the app) | App embed / app block |
| `cdn.shopify.com/shopifycloud/…`, `monorail-edge.shopifysvc.com`, `trekkie` | Shopify platform | Analytics, checkout, consent, web pixels | Platform (`content_for_header`) |
| `shop.app`, `shopifycloud/shop-js` | Shop Pay / Shop app | Login, accelerated checkout | Platform |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Google Fonts | Web fonts | Theme code |
| `youtube.com/embed`, `ytimg.com`, `vimeo.com` | Video embeds | Video | Theme code / sections |
| `lottiefiles.com`, `lottie` | Lottie | Animations | Theme code / app |
| `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com` | Public CDNs | Libraries the theme or an app pulls in | Theme code (search for the URL) |

Patterns worth flagging wherever they appear:
- the same library loaded twice (e.g. two copies of a slider or jQuery, or GTM plus a separate GA4 tag sending the same events)
- tracking pixels loaded both by an app and inside GTM
- chat or review widgets loading on every page at full weight when a visitor may never open them
- third-party scripts with no or very short caching
