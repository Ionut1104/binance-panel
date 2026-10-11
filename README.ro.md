# Binance Panel — trading manual rapid

Panel single-page (React) + backend Node.js care execută ordine prin **Binance WebSocket API** (conexiune persistentă, nu REST) pentru latență minimă. Spot + Futures USDT-M, Testnet + Live.

> ⚠️ **Disclaimer**: unealtă de execuție, nu sfat de investiții. Testeaz-o serios pe Testnet înainte de orice ban real. Tradingul cu leverage poate lichida contul.

---

## 1. Cerințe

- **Node.js ≥ 18** (include `fetch` nativ) — [nodejs.org](https://nodejs.org)
- Chei API Binance (vezi mai jos)

## 2. Chei API

**Testnet (recomandat la început — bani falși):**
- Spot Testnet: <https://testnet.binance.vision> → login cu GitHub → *Generate HMAC_SHA256 Key*
- Futures Testnet: <https://testnet.binancefuture.com> → login → *API Key* (tab-ul din partea de jos a paginii)

**Live (mai târziu):** Binance → *API Management* → creează cheie cu permisiuni **Enable Spot / Enable Futures Trading**. NU activa withdrawals. Restricționează pe IP-ul VPS-ului.

## 3. Rulare locală

```bash
# 1. Backend
cd server
cp .env.example .env
# editează .env: pune un PANEL_SECRET lung și aleatoriu:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm install
npm start          # pornește pe http://localhost:8787

# 2. Frontend (alt terminal)
cd client
npm install
npm run dev        # deschide http://localhost:5173
```

Deschide <http://localhost:5173> → **⚙ Setări** → introdu API key + secret, alege Spot/Futures și Testnet → *Salvează & Reconectează*. Cheile se salvează **criptat AES-256-GCM** în `server/data/settings.enc.json` (decriptabile doar cu `PANEL_SECRET` din `.env`).

**Rulare "producție" locală (un singur proces):**

```bash
cd client && npm run build     # generează client/dist
cd ../server && npm start      # servește UI + API pe http://localhost:8787
```

**Pornire rapidă (Windows):** dublu-click pe `start-panel.bat` (sau pe scurtătura **Binance Panel** de pe Desktop) — pornește serverul și deschide automat `http://localhost:8787` în browser după 2 secunde. Lasă fereastra deschisă cât timp tranzacționezi; închizând-o oprești panelul.

## 4. Hotkeys implicite (remapabile din Setări)

| Tastă | Acțiune | Tastă | Acțiune |
|---|---|---|---|
| `B` / `S` | BUY / SELL market | `H` | Sell 1/2 |
| `⇧B` / `⇧S` | BUY / SELL limit ± offset | `C` | Close All |
| `⌃B` / `⌃S` | BUY / SELL @ trigger | `I` / `O` | Scale In / Out |
| `L` / `T` | Stop Loss / Take Profit | `R` | Reverse |
| `K` | ⛔ KILL / Flatten All | `X` | Cancel All |
| `1`–`9` | Simboluri favorite | `Q` | Focus căutare |

Hotkey-urile simple sunt inactive cât timp scrii într-un câmp de text (ex. `B` nu trebuie să tragă BUY MARKET cât timp bați o cifră) — dar cele cu `Ctrl`/`Alt` (⌃B/⌃S) rămân active chiar și din câmpul **Intrare la preț**, exact ca să poți: `Tab` în câmp (se completează singur cu prețul curent) → ajustezi dacă vrei → `Ctrl+B`/`Ctrl+S` fără să dai click în altă parte.

### 4.1 Intrare condiționată de preț ("trigger")

Câmpul **Intrare la preț** din panel îți permite să pregătești o intrare care se execută abia când prețul live ajunge acolo — ex: prețul e la 0.58, tu vrei să intri la 0.6 → scrii `0.6`, apeși **BUY @ trigger**, iar ordinul (MKT sau LMT ±, selectabil din dropdown) pleacă automat doar când prețul atinge 0.6, indiferent dacă vine de jos sau de sus. Direcția (sus/jos) se detectează automat din poziția prețului trigger față de prețul curent. Trigger-ele apar în tabelul de ordine cu simbolul ⏳ și pot fi anulate cu ✕ oricând înainte să fie atinse; sunt urmărite doar în memoria serverului (nu sunt ordine reale pe Binance până nu se declanșează), deci dispar dacă restartezi serverul sau schimbi simbolul.

Același lucru, dar pentru **Stop Loss / Take Profit**: câmpurile `SL` și `TP` (acum separate, fiecare cu propria valoare) au și opțiunea **preț** — introdu prețul exact de ieșire (nu % sau ticks față de entry) și apasă `L`/`STOP LOSS` sau `T`/`TAKE PROFIT` ca de obicei. Spre deosebire de trigger-ul de intrare, acesta pleacă direct ca ordin real STOP_MARKET/TAKE_PROFIT_MARKET pe Binance (reduceOnly), deci se declanșează chiar dacă închizi panelul sau serverul cade — corect pentru managementul riscului pe o poziție deja deschisă.

### 4.2 SL / TP separate, Close % customizabil, SL automat opțional

- **SL și TP au valori independente** — înainte era un singur câmp comun (`SL/TP`), folosit de ambele butoane; acum `SL` și `TP` au fiecare propriul mod (%/ticks/preț) și propria valoare, ca să poți ține ex. SL la 0.5% și TP la 2% simultan, fără să comuți câmpul între click-uri.
- **`SELL 1/2` e acum `Close %` customizabil** — nu mai e fixat la 50%; schimbă valoarea din câmpul `Close %` și butonul (+ hotkey `H`) închide exact procentul ales.
- **SL automat la intrare — implicit OFF, DOAR dacă bifezi tu explicit** căsuța „SL automat la intrare": când e bifată, orice intrare — `BUY MKT`/`SELL MKT`, `BUY LMT ±`/`SELL LMT ±`, sau un trigger de preț (§4.1), indiferent dacă e MKT sau LMT — primește automat un Stop Loss calculat din câmpul `SL`, imediat ce se confirmă fill-ul REAL (nu răspunsul inițial al ordinului — pt. MARKET, WS-API răspunde cu status `NEW` chiar și când se umple instant; prețul de execuție vine separat, pe user stream).
  - Pentru **MARKET** (direct sau din trigger): se umple aproape instant, deci așteptăm fill-ul în ACELAȘI lanț de operații serializate — o acțiune imediat următoare (ex. Close All) vede SL-ul deja plasat.
  - Pentru **LIMIT** (direct sau din trigger): poate sta neumplut minute/ore, deci NU blocăm coada de operații — SL-ul automat rulează în fundal, cu un timeout mult mai generos (6 ore). Dacă anulezi manual ordinul LIMIT înainte să se umple, pur și simplu nu se mai plasează niciun SL.
- Dacă SL automat eșuează (ex. limitarea `-4120` de pe testnet, §4.1), primești un toast clar `✗ SL automat eșuat` cu motivul — nu eșuează silențios.

### 4.3 Levier automat la maxim (futures)

La fiecare schimbare de simbol (căutare, click pe favorit, `1`–`9`), panelul interoghează `/fapi/v1/leverageBracket` — levierul maxim pe care **contul tău** îl are voie pentru perechea aia (poate diferi între perechi și e limitat de brackets de risc, nu doar de simbol) — și îl setează automat, cu un toast de confirmare (`⚡ Levier auto: 50×`). Dropdown-ul de Leverage rămâne editabil manual dacă vrei mai puțin.

De ce contează pentru sizing: câmpul **Size** e mereu o valoare **notional** (expunere totală), nu marjă — la Size fix (ex. 500 USDT), marja reală blocată din balanță e `notional / leverage`. Cu levierul mereu la maximul permis, orice poziție de 500 USDT folosește automat marja minimă posibilă pentru acea sumă, fără să calculezi tu nimic.

> ⚠️ **SL/TP pe Futures = Algo Order API**: din 2025-12-09 Binance acceptă ordinele condiționale (`STOP_MARKET`, `TAKE_PROFIT_MARKET` etc.) doar prin `POST /fapi/v1/algoOrder`; endpoint-ul clasic și WS-API le resping cu `-4120`. Panelul folosește endpoint-ul Algo (testat pe Live). Futures Testnet s-ar putea să nu le accepte — validează SL/TP pe Live, cu o sumă mică.

## 5. Arhitectură (pe scurt)

```
Browser (React) ──WebSocket──▶ Backend Node ──┬─▶ WS-API Binance (ordine, persistent, HMAC)
                                              ├─▶ Market stream (bookTicker live)
                                              ├─▶ User data stream (fill-uri, poziție, balanță)
                                              └─▶ REST (doar rar: listenKey, leverage, exchangeInfo)
```

- **Latență**: ordinele pleacă pe o conexiune WS deja deschisă și autentificată, ținută caldă cu ping la 30s. `recvWindow=3000ms`, ceas sincronizat cu Binance la pornire + la 15 min. Toate cele 4 conexiuni WS (WS-API, market stream, user stream, browser↔backend) au **compresia dezactivată** (`perMessageDeflate: false` — adaugă CPU/latență pe frame-uri JSON mici, fără beneficiu) și **TCP_NODELAY** (dezactivează Nagle's algorithm, care altfel poate întârzia un pachet mic până la ~40ms așteptând să se umple bufferul) — vezi `server/src/lowLatency.js`.
- **UI optimist**: butoanele de execuție trag pe **mousedown**, nu pe click (= mouseup) — ordinul pleacă la apăsare, nu la eliberare, câștigi durata unui click uman (~60-100ms). Afișare instant + sunet; confirmarea reală (fill verde / reject roșu) vine pe user stream și se împerechează după `clientOrderId`.
- **REST cald pentru SL/TP**: `STOP_MARKET`/`TAKE_PROFIT_MARKET` merg prin REST (vezi limitarea din §4.1), nu prin WS-API — iar `fetch()` global ține conexiunile calde doar ~4s implicit. Am extins fereastra la 60s (`extendRestKeepAlive()` în `lowLatency.js`) + un ping periodic la 45s, ca un SL/TP plasat rar să nu plătească un TCP+TLS handshake nou (~2-3 RTT, potențial 500ms+) exact când contează cel mai mult.
- **Reconectare**: toate cele 4 conexiuni au reconnect automat cu backoff; indicatorii din bara de sus arată starea fiecăreia.
- **Risc**: max USD/ordin și max USD/poziție verificate server-side înainte de fiecare ordin; rotunjire automată la tickSize/stepSize.
- **Operații serializate + Close All robust**: dacă tragi două butoane care schimbă poziția foarte rapid unul după altul (ex. Scale In apoi Close All, sau Buy Market apoi Close All), al doilea AȘTEAPTĂ ca primul să ajungă complet la Binance înainte să-și calculeze cantitatea — altfel Close All putea porni de la o poziție veche și lăsa un rest nevândut ("praf"). În plus, o închidere 100% reîmprospătează poziția reală de pe cont ÎNAINTE de fiecare încercare și repetă (până la 4 runde) până confirmă 0 — Binance are un mic decalaj intern între "ordinul e confirmat" și "poziția e vizibilă prin REST", iar un singur refresh nu acoperea mereu acest decalaj. Cost: Close All / Flatten sunt cu ~1 rundă REST mai lente (corectitudinea contează mai mult ca milisecundele la un buton de "închide tot").
- **Cancel All / Flatten curăță și trigger-ele**: `CANCEL ALL` și `⛔ KILL / FLATTEN ALL` anulau doar ordinele reale de pe Binance — trigger-ele software (intrare condiționată, §4.1) nu sunt ordine reale până nu se declanșează, deci rămâneau agățate în listă chiar dacă toast-ul zicea "✓ Ordine anulate". Acum `cancelAll()` golește și lista de trigger-e.

## 6. Deploy pe AWS Tokyo (`ap-northeast-1`)

Serverele de matching Binance sunt în AWS Tokyo — un VPS acolo taie latența la ~1–3 ms **între backend și Binance**.

> ⚠️ **Ce chiar câștigi cu asta.** Pentru un click manual (BUY MKT etc.), latența România↔Tokyo (~120-150ms într-o direcție, ~250ms+ dus-întors pe o conexiune obișnuită) nu dispare — doar se mută: fie stă pe segmentul backend→Binance (backend local, cum rulează acum), fie pe segmentul tu→backend (backend pe VPS). Timpul total până ajunge ordinul la bursă e, fizic, cam același. VPS-ul NU face click-urile manuale mai rapide.
>
> Unde chiar contează enorm: **Stop Loss / Take Profit și trigger-ul de intrare** (secțiunea 4.1) — astea reacționează *fără tine*, direct pe backend, la fiecare tick de preț. Cu backend local, reacția "preț atinge SL → ordin trimis" durează cât backend→Binance dus-întors (~250ms+, din cauza distanței). Cu backend pe VPS în Tokyo, aceeași reacție durează ~1-5ms, pentru că totul — preț primit, decizie, ordin trimis — se întâmplă în același datacenter. Asta e diferența reală: SL-ul tău se declanșează la momentul potrivit, nu cu 250ms întârziere (= slippage suplimentar pe o piață care se mișcă rapid).
>
> Deci: dacă te bazezi mult pe SL/TP automate și pe trigger-ul de intrare, VPS-ul chiar merită. Dacă tranzacționezi 100% manual din click-uri, nu te ajută cu nimic — mai bine investești în o conexiune stabilă (cablu, nu WiFi) și un tab de browser mereu în prim-plan.

### 6.1 Creează instanța

1. AWS Console → schimbă regiunea în **Asia Pacific (Tokyo) ap-northeast-1**.
2. EC2 → *Launch instance*: Ubuntu 24.04, `t3.small` e suficient, cheie SSH nouă.
3. **Security Group**: permite inbound doar **SSH (22)** de la IP-ul tău. **NU deschide portul 8787 public** — vei accesa panelul prin tunel SSH (mai jos).

### 6.2 Instalează și pornește

```bash
ssh -i cheia-ta.pem ubuntu@IP_INSTANTA

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# copiază proiectul (de pe mașina ta):
#   scp -i cheia-ta.pem -r binance-panel ubuntu@IP_INSTANTA:~/

cd ~/binance-panel/client && npm install && npm run build
cd ~/binance-panel/server && npm install
cp .env.example .env && nano .env    # PANEL_SECRET nou + PANEL_TOKEN setat!

# pm2 = ține procesul în viață + restart la reboot
sudo npm install -g pm2
pm2 start src/index.js --name binance-panel
pm2 save && pm2 startup   # rulează comanda pe care ți-o afișează
```

### 6.3 Accesează panelul (tunel SSH — sigur, criptat)

Pe mașina ta:

```bash
ssh -i cheia-ta.pem -N -L 8787:localhost:8787 ubuntu@IP_INSTANTA
```

Apoi deschide <http://localhost:8787> — panelul rulează în Tokyo, tu doar îl comanzi. Ordinele pleacă din Tokyo către Binance (rapid); doar click-urile tale traversează oceanul.

> Dacă vrei acces fără tunel, pune un reverse proxy (Caddy/nginx) cu HTTPS + setează `PANEL_TOKEN` și `ALLOWED_ORIGINS=https://domeniul-tau` în `.env`, apoi salvează token-ul în browser cu `localStorage.setItem('panelToken','...')` în consolă. Tunelul SSH rămâne varianta cea mai sigură.

### Securitate implicită
- Serverul ascultă doar pe `127.0.0.1`: alte dispozitive din rețea (Wi-Fi, LAN) nu ajung la panel.
- WebSocket-ul de trading respinge conexiunile venite de pe alte site-uri (verificare `Origin`). Un site rău-intenționat deschis în browser nu poate trimite ordine prin panel.
- Panelul nu are cod de retragere (withdraw). Cheia API trebuie creată fără permisiunea de Withdrawals.

### 6.4 Pe Live, restricționează cheia API la IP-ul static al instanței (alocă un Elastic IP).

## 7. Structura proiectului

```
server/src/
  index.js        # Express + WS server, protocolul cu UI-ul
  session.js      # logica de trading: ordine, poziție, risc, rotunjiri
  wsApi.js        # conexiunea WS-API Binance (ordine, latență minimă)
  marketStream.js # preț live (bookTicker) + resubscribe la schimbare simbol
  userStream.js   # fill-uri / balanță / poziție (listenKey)
  rest.js         # REST: listenKey, leverage, exchangeInfo, SL/TP (Algo API), fallback poziție/ordine
  timeSync.js     # sincronizare ceas Binance (evită eroarea -1021)
  crypto.js       # AES-256-GCM + semnătura HMAC
  settings.js     # setări persistate criptat
  endpoints.js    # URL-urile Binance (spot/futures × testnet/live)
client/src/
  App.jsx         # starea globală, act() = dispatcher acțiuni, UI optimist
  ws.js           # WebSocket către backend, reconnect + request/response
  hotkeys.js      # mapare taste, remapare, afișare pe butoane
  sounds.js       # feedback sonor WebAudio
  components/     # TradePanel, PositionCard, OrdersTable, SymbolBar,
                  # SettingsModal, StatusBar, Toasts
```

## 8. Limitări cunoscute

- Pe **Spot** nu există short și nici "poziție" nativă — entry-ul e reconstruit local din fill-uri (se pierde la restart de server; poziția ca mărime rămâne corectă din balanță).
- **Reverse** pe Spot doar închide poziția (nu poate deschide short).
- Futures e presupus în **One-way mode** (nu Hedge mode) — setarea implicită Binance.
- Pe unele conturi Binance nu trimite evenimente pe user stream; panelul trece automat pe citire REST (poziție, ordine, fill-uri la ~3s).
- Trigger-ele de preț stau în memoria serverului — se pierd la repornire (ordinele reale rămân pe Binance).
- Endpoint-urile Binance se mai schimbă; dacă ceva nu se conectează, verifică `server/src/endpoints.js` față de docs.
