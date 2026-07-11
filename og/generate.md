# Regenerate og.png (1200×630 social card)

Run from the repo root after editing `og/card.html`:

```
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1200,630 --force-device-scale-factor=1 --screenshot="$PWD/og.png" "file://$PWD/og/card.html"
```

Verify: `identify og.png` must print `1200x630` and the file must stay under 600 KB (currently ~410 KB). The card references `../assets/pfps/**` so those PNGs must exist locally when you screenshot; `og.png` is committed at the repo root and served at `https://bitcoin-spam-war.vercel.app/og.png`.
