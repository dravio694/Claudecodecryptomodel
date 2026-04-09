/**
 * LastClick Auction — Server v2.0
 * ─────────────────────────────────
 * Modules :
 *   CONFIG         — paramètres centralisés
 *   Store          — persistance JSON (swappable vers DB)
 *   AuctionEngine  — logique métier encapsulée
 *   SolanaVerifier — vérification on-chain SPL USDC
 *   App            — Express + Socket.IO
 */

"use strict";

const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const express   = require("express");
const http      = require("http");
const cors      = require("cors");
const socketIo  = require("socket.io");
const requestIp = require("request-ip");
const rateLimit = require("express-rate-limit");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddress } = require("@solana/spl-token");

// ═══════════════════════════════════════════════════════════════════════
// 1. CONFIG
// ═══════════════════════════════════════════════════════════════════════

;(function loadEnv() {
  const found = [".env", "env"]
    .map(f => path.join(__dirname, f))
    .find(f => fs.existsSync(f));
  require("dotenv").config(found ? { path: found } : {});
})();

const CONFIG = Object.freeze({
  PORT:                Number(process.env.PORT                || 3000),
  SOLANA_RPC:          process.env.SOLANA_RPC                 || "https://api.mainnet-beta.solana.com",
  PLATFORM_WALLET:     process.env.PLATFORM_WALLET,
  USDC_MINT:           process.env.USDC_MINT                  || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDC_DECIMALS:       6,

  // Enchère
  AUCTION_DURATION_MS: Number(process.env.AUCTION_DURATION_MS || 86_400_000),
  PRICE_START:         Number(process.env.PRICE_START         || 10.00),
  PRICE_FLOOR:         Number(process.env.PRICE_FLOOR         || 0.10),
  PRICE_STEP:          Number(process.env.PRICE_STEP          || 0.10),
  PRICE_MULTIPLIER:    Number(process.env.PRICE_MULTIPLIER    || 1.20),

  // Sécurité
  WALLET_COOLDOWN_MS:  Number(process.env.WALLET_COOLDOWN_MS  || 8_000),
  QUOTE_TTL_MS:        Number(process.env.QUOTE_TTL_MS        || 120_000),
  TX_MAX_AGE_MS:       Number(process.env.TX_MAX_AGE_MS       || 300_000),

  // Misc
  DATA_DIR:            fs.existsSync("/data") ? "/data" : __dirname,
  REWARD_NAME:         "Claudecodetrading",
  HISTORY_SIZE:        10,
});

if (!CONFIG.PLATFORM_WALLET) {
  console.error("❌  Variable d'env PLATFORM_WALLET manquante — arrêt");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. STORE  (persistance fichier — remplacez les fonctions par Supabase si besoin)
// ═══════════════════════════════════════════════════════════════════════

const Store = (() => {
  const stateFile     = path.join(CONFIG.DATA_DIR, "state.json");
  const processedFile = path.join(CONFIG.DATA_DIR, "processed-signatures.json");

  function read(file, fallback) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { console.error(`[Store] read(${file}):`, e.message); }
    return fallback;
  }

  function write(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch (e) { console.error(`[Store] write(${file}):`, e.message); }
  }

  return {
    loadState:     ()    => read(stateFile, null),
    saveState:     (s)   => write(stateFile, s),
    loadProcessed: ()    => new Set(read(processedFile, [])),
    saveProcessed: (set) => write(processedFile, [...set]),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// 3. AUCTION ENGINE
// ═══════════════════════════════════════════════════════════════════════

const AuctionEngine = (() => {

  // ── État ─────────────────────────────────────────────────────────────
  let state = {
    price:          CONFIG.PRICE_START,
    endTime:        Date.now() + CONFIG.AUCTION_DURATION_MS,
    buyerCount:     0,
    lastBuyer:      null,   // adresse complète — jamais exposée côté client
    lastBuyerShort: null,
    history:        [],
    isActive:       true,
    ...( Store.loadState() || {} ),
  };

  let processedSigs  = Store.loadProcessed();
  const cooldowns    = new Map();   // walletAddress → timestamp dernier achat
  const quotes       = new Map();   // quoteId → { buyerAddress, amountUSDC, expiresAt, used }

  console.log(`[AuctionEngine] Chargé — prix : ${state.price} USDC | actif : ${state.isActive}`);
  console.log(`[AuctionEngine] ${processedSigs.size} signatures traitées`);

  // ── Helpers privés ────────────────────────────────────────────────────
  const short = (a) => a ? a.slice(0, 4) + "…" + a.slice(-4) : null;
  const uid   = () => crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");

  function persist() {
    Store.saveState({
      price:          state.price,
      endTime:        state.endTime,
      buyerCount:     state.buyerCount,
      lastBuyerShort: state.lastBuyerShort,
      history:        state.history,
      isActive:       state.isActive,
      // lastBuyer complet intentionnellement omis
    });
  }

  // ── Interface publique ────────────────────────────────────────────────
  return {

    /** Snapshot envoyé aux clients WebSocket et REST */
    publicState() {
      return {
        price:      state.price,
        endTime:    state.endTime,
        buyerCount: state.buyerCount,
        lastBuyer:  state.lastBuyerShort,
        history:    state.history,
        isActive:   state.isActive,
      };
    },

    /** Baisse du prix — appelé par setInterval 10 min */
    tickPriceDown() {
      if (!state.isActive) return null;
      const next = Math.max(CONFIG.PRICE_FLOOR, +((state.price - CONFIG.PRICE_STEP).toFixed(2)));
      if (next === state.price) return null;
      state.price = next;
      persist();
      console.log(`[AuctionEngine] Prix baissé → ${state.price} USDC`);
      return this.publicState();
    },

    /** Vérification fin d'enchère — appelé toutes les secondes */
    tickCheckEnd() {
      if (!state.isActive || Date.now() < state.endTime) return null;
      state.isActive = false;
      persist();
      console.log(`[AuctionEngine] Enchère terminée — gagnant : ${state.lastBuyerShort}`);
      return { winner: state.lastBuyerShort, finalPrice: state.price };
    },

    /** Crée une quote (verrou de prix pendant QUOTE_TTL_MS) */
    createQuote(buyerAddress) {
      if (!state.isActive)
        return { ok: false, error: "Enchère terminée" };

      const now  = Date.now();
      const last = cooldowns.get(buyerAddress) || 0;
      if (now - last < CONFIG.WALLET_COOLDOWN_MS)
        return { ok: false, error: "Cooldown actif — patientez quelques secondes" };

      const quoteId    = uid();
      const amountUSDC = +state.price.toFixed(2);
      const expiresAt  = now + CONFIG.QUOTE_TTL_MS;

      quotes.set(quoteId, { buyerAddress, amountUSDC, expiresAt, used: false });

      return { ok: true, quoteId, amountUSDC, expiresAt };
    },

    /** Retourne le montant de la quote (pour la vérif Solana) sans la consommer */
    getQuoteAmount(quoteId, buyerAddress) {
      const q = quotes.get(quoteId);
      if (!q || q.used || q.buyerAddress !== buyerAddress || Date.now() > q.expiresAt)
        return null;
      return q.amountUSDC;
    },

    /** Applique un achat après vérification Solana confirmée */
    applyPurchase(buyerAddress, signature, quoteId) {
      if (!state.isActive)
        return { ok: false, error: "Enchère terminée" };

      const q = quotes.get(quoteId);
      if (!q)                            return { ok: false, error: "Quote introuvable" };
      if (q.used)                        return { ok: false, error: "Quote déjà utilisée" };
      if (q.buyerAddress !== buyerAddress) return { ok: false, error: "Quote non liée à ce wallet" };
      if (Date.now() > q.expiresAt)      return { ok: false, error: "Quote expirée" };

      // Anti-replay
      if (processedSigs.has(signature))
        return { ok: true, alreadyProcessed: true, state: this.publicState() };

      const oldPrice = state.price;
      const now      = Date.now();

      processedSigs.add(signature);
      Store.saveProcessed(processedSigs);
      cooldowns.set(buyerAddress, now);
      q.used = true;

      state.price          = +((state.price * CONFIG.PRICE_MULTIPLIER).toFixed(2));
      state.endTime        = now + CONFIG.AUCTION_DURATION_MS;
      state.buyerCount    += 1;
      state.lastBuyer      = buyerAddress;
      state.lastBuyerShort = short(buyerAddress);
      state.history.unshift(state.lastBuyerShort);
      if (state.history.length > CONFIG.HISTORY_SIZE) state.history.pop();
      persist();

      console.log(`[AuctionEngine] ✅ Achat — ${state.lastBuyerShort} | ${oldPrice}→${state.price} USDC`);

      return {
        ok:         true,
        oldPrice,
        newPrice:   state.price,
        buyer:      state.lastBuyerShort,
        rewardName: CONFIG.REWARD_NAME,
        state:      this.publicState(),
      };
    },

    /** Purge les quotes et cooldowns expirés (appel périodique) */
    purge() {
      const now = Date.now();
      for (const [id, q] of quotes) {
        if (now > q.expiresAt + 60_000) quotes.delete(id);
      }
    },
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// 4. SOLANA VERIFIER
// ═══════════════════════════════════════════════════════════════════════

const SolanaVerifier = (() => {
  const PLATFORM = new PublicKey(CONFIG.PLATFORM_WALLET);
  const MINT     = new PublicKey(CONFIG.USDC_MINT);
  const conn     = new Connection(CONFIG.SOLANA_RPC, "confirmed");

  function toBase58(k) {
    if (!k) return "";
    if (typeof k === "string")            return k;
    if (typeof k.toBase58 === "function") return k.toBase58();
    if (k.pubkey)                         return toBase58(k.pubkey);
    return String(k);
  }

  function parseAmount(info) {
    if (!info) return NaN;
    if (info.tokenAmount?.amount != null) return Number(info.tokenAmount.amount);
    if (info.amount != null)              return Number(info.amount);
    return NaN;
  }

  function matchTransfer(ix, rawAmount, buyerAta, platformAta, buyerAddr) {
    if (!ix?.parsed) return false;
    const { type, info = {} } = ix.parsed;
    if (type !== "transfer" && type !== "transferChecked") return false;

    const mintOk = type === "transfer"
      ? true
      : (info.mint || info.tokenAmount?.mint || "") === MINT.toBase58();

    return (
      info.source      === buyerAta    &&
      info.destination === platformAta &&
      info.authority   === buyerAddr   &&
      parseAmount(info) === rawAmount  &&
      mintOk
    );
  }

  function hasTransfer(tx, rawAmount, buyerAta, platformAta, buyerAddr) {
    const check = ix => matchTransfer(ix, rawAmount, buyerAta, platformAta, buyerAddr);
    for (const ix of tx.transaction.message.instructions || [])
      if (check(ix)) return true;
    for (const g of tx.meta?.innerInstructions || [])
      for (const ix of g.instructions || [])
        if (check(ix)) return true;
    return false;
  }

  return {
    async verify(buyerAddress, signature, amountUSDC) {
      let tx;
      try {
        tx = await conn.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch (e) {
        return { ok: false, error: "Erreur RPC : " + e.message };
      }

      if (!tx)          return { ok: false, error: "Transaction introuvable" };
      if (tx.meta?.err) return { ok: false, error: "Transaction en erreur on-chain" };

      // Fraîcheur
      if (tx.blockTime) {
        const ageMs = Date.now() - tx.blockTime * 1_000;
        if (ageMs > CONFIG.TX_MAX_AGE_MS)
          return { ok: false, error: `Transaction trop ancienne (${Math.round(ageMs / 60_000)} min — max 5)` };
      }

      // Signataire strict (k.signer === true uniquement)
      const signerOk = (tx.transaction.message.accountKeys || []).some(
        k => toBase58(k) === buyerAddress && k.signer === true
      );
      if (!signerOk)
        return { ok: false, error: "Signataire de la tx ≠ wallet déclaré" };

      // Vérification transfert USDC
      let buyerPub;
      try { buyerPub = new PublicKey(buyerAddress); }
      catch { return { ok: false, error: "Adresse wallet invalide" }; }

      const [buyerAta, platformAta] = await Promise.all([
        getAssociatedTokenAddress(MINT, buyerPub, false).then(k => k.toBase58()),
        getAssociatedTokenAddress(MINT, PLATFORM,  false).then(k => k.toBase58()),
      ]);

      const rawAmount = Math.round(amountUSDC * 10 ** CONFIG.USDC_DECIMALS);
      if (!hasTransfer(tx, rawAmount, buyerAta, platformAta, buyerAddress))
        return { ok: false, error: "Transfert USDC introuvable ou montant incorrect" };

      return { ok: true };
    },

    platformWallet: () => PLATFORM.toBase58(),
    usdcMint:       () => MINT.toBase58(),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// 5. EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(requestIp.mw());

// ── Rate limiters ─────────────────────────────────────────────────────
const makeLimit = (max) => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: req => req.clientIp || req.ip || "anon",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ success: false, error: "Trop de requêtes — réessayez dans 1 minute" }),
});

// ── Routes REST ───────────────────────────────────────────────────────

app.get("/api/state", (_req, res) => {
  res.json(AuctionEngine.publicState());
});

app.get("/api/config", (_req, res) => {
  res.json({
    platformWallet: SolanaVerifier.platformWallet(),
    usdcMint:       SolanaVerifier.usdcMint(),
    usdcDecimals:   CONFIG.USDC_DECIMALS,
    rewardName:     CONFIG.REWARD_NAME,
  });
});

// POST /api/quote  — crée un verrou de prix
app.post("/api/quote", makeLimit(10), (req, res) => {
  const { buyerAddress } = req.body || {};
  if (!buyerAddress)
    return res.json({ success: false, error: "buyerAddress manquant" });

  try { new PublicKey(buyerAddress); }
  catch { return res.json({ success: false, error: "Adresse wallet invalide" }); }

  const result = AuctionEngine.createQuote(buyerAddress);
  if (!result.ok)
    return res.json({ success: false, error: result.error });

  return res.json({
    success:        true,
    quoteId:        result.quoteId,
    amountUSDC:     result.amountUSDC,
    expiresAt:      result.expiresAt,
    platformWallet: SolanaVerifier.platformWallet(),
    usdcMint:       SolanaVerifier.usdcMint(),
    decimals:       CONFIG.USDC_DECIMALS,
  });
});

// POST /api/verify-payment  — vérifie la tx Solana puis applique l'achat
app.post("/api/verify-payment", makeLimit(20), async (req, res) => {
  const { buyerAddress, signature, quoteId } = req.body || {};

  if (!buyerAddress || !signature || !quoteId)
    return res.json({ success: false, error: "buyerAddress, signature et quoteId sont requis" });

  // Récupérer le montant attendu depuis la quote (lecture seule)
  const amountUSDC = AuctionEngine.getQuoteAmount(quoteId, buyerAddress);
  if (amountUSDC === null)
    return res.json({ success: false, error: "Quote introuvable, expirée ou non liée à ce wallet" });

  // Vérification Solana on-chain
  const solana = await SolanaVerifier.verify(buyerAddress, signature, amountUSDC);
  if (!solana.ok)
    return res.json({ success: false, error: solana.error });

  // Appliquer l'achat dans le moteur
  const purchase = AuctionEngine.applyPurchase(buyerAddress, signature, quoteId);
  if (!purchase.ok)
    return res.json({ success: false, error: purchase.error });

  if (purchase.alreadyProcessed)
    return res.json({ success: true, alreadyProcessed: true, ...purchase.state });

  // Broadcaster aux clients connectés
  io.emit("priceUpdate", purchase.state);
  io.emit("newPurchase", {
    buyer:      purchase.buyer,
    price:      purchase.oldPrice,
    rewardName: purchase.rewardName,
  });

  return res.json({
    success:    true,
    newPrice:   purchase.newPrice,
    rewardName: purchase.rewardName,
    ...purchase.state,
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("init",        AuctionEngine.publicState());
  socket.emit("statsUpdate", { online: io.engine.clientsCount });
});

// ── Timers serveur ────────────────────────────────────────────────────
setInterval(() => {
  const update = AuctionEngine.tickPriceDown();
  if (update) io.emit("priceUpdate", update);
}, 10 * 60_000);

setInterval(() => {
  const ended = AuctionEngine.tickCheckEnd();
  if (ended) io.emit("auctionEnded", ended);
}, 1_000);

setInterval(() => {
  io.emit("statsUpdate", { online: io.engine.clientsCount });
  AuctionEngine.purge();
}, 4_000);

// ── Démarrage ─────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log("═══════════════════════════════════════════════");
  console.log("  LastClick Auction  v2.0");
  console.log(`  Port      : ${CONFIG.PORT}`);
  console.log(`  RPC       : ${CONFIG.SOLANA_RPC}`);
  console.log(`  Wallet    : ${CONFIG.PLATFORM_WALLET}`);
  console.log(`  Data      : ${CONFIG.DATA_DIR}`);
  console.log("═══════════════════════════════════════════════");
});
