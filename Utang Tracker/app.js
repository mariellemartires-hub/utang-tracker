// Utang Tracker — wallet connect, balance, debt list (with partial payments,
// shareable IOU links, and per-person history) built on Freighter + Stellar SDK.
// Debts are stored in the browser's localStorage, keyed per-app (not per-wallet —
// keep that in mind if you connect a different wallet later).

// These come from the <script> tags in index.html (loaded from cdnjs),
// which expose window.freighterApi and window.StellarSdk as globals —
// no bundler or import resolution needed.
const freighterApi = window.freighterApi;
const StellarSdk = window.StellarSdk;

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const STORAGE_KEY = "utang-tracker:debts";

// Different SDK versions expose the Horizon client differently
// (StellarSdk.Server in older builds, StellarSdk.Horizon.Server in newer
// ones) — this works with either.
function getServer() {
  const ServerClass = StellarSdk.Horizon?.Server || StellarSdk.Server;
  return new ServerClass(HORIZON_URL);
}

// Approximate, fixed conversion rate for display purposes only — swap this
// for a live rate lookup later if you want real-time accuracy.
const XLM_TO_PHP = 25;

const NUDGES = [
  "{name} still owes you {amount} XLM 👀",
  "Wag kalimutan: {name} — {amount} XLM pa.",
  "Sana all makabayad na si {name}. ({amount} XLM)",
  "Ping si {name} tungkol sa {amount} XLM.",
];

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const walletChip = document.getElementById("wallet-chip");
const walletAddressShort = document.getElementById("wallet-address-short");
const appPanel = document.getElementById("app-panel");
const lockedMsg = document.getElementById("locked-msg");
const panelContent = document.getElementById("panel-content");
const balanceValue = document.getElementById("balance-value");
const refreshBtn = document.getElementById("refresh-btn");
const totalUnpaidXlmEl = document.getElementById("total-unpaid-xlm");
const totalUnpaidPhpEl = document.getElementById("total-unpaid-php");
const nudgeText = document.getElementById("nudge-text");
const addDebtForm = document.getElementById("add-debt-form");
const debtNameInput = document.getElementById("debt-name");
const debtAddressInput = document.getElementById("debt-address");
const debtAmountInput = document.getElementById("debt-amount");
const tabButtons = document.querySelectorAll(".tab-btn");
const debtListEl = document.getElementById("debt-list");
const emptyState = document.getElementById("empty-state");
const resultPanel = document.getElementById("result-panel");
const cardTemplate = document.getElementById("debt-card-template");
const iouBanner = document.getElementById("ioo-banner");
const iouDesc = document.getElementById("ioo-desc");
const iouPayBtn = document.getElementById("ioo-pay-btn");

let connectedAddress = null;
let debts = loadDebts();
let activeTab = "unsettled";
let sharedIouParams = null;

// ---------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------
function loadDebts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function saveDebts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(debts));
}
function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------
// Wallet connect / disconnect
// ---------------------------------------------------------------------
async function connectWallet() {
  const installed = await freighterApi.isConnected();
  if (!installed.isConnected) {
    alert("Freighter wallet isn't installed. Get it at freighter.app, then reload this page.");
    return;
  }
  const network = await freighterApi.getNetwork();
  if (network.network !== "TESTNET") {
    alert("Please switch Freighter to Testnet, then click Connect again.");
    return;
  }
  const access = await freighterApi.requestAccess();
  if (access.error) {
    alert("Connection was declined in Freighter.");
    return;
  }
  connectedAddress = access.address;
  onWalletConnected();
}

function disconnectWallet() {
  // Freighter has no dapp-side "revoke" call — the permission lives in the
  // extension. Disconnecting here clears this app's own session state.
  connectedAddress = null;
  walletChip.classList.add("hidden");
  connectBtn.classList.remove("hidden");
  appPanel.classList.add("disabled");
  lockedMsg.classList.remove("hidden");
  panelContent.classList.add("hidden");
  resultPanel.classList.add("hidden");
}

function onWalletConnected() {
  walletAddressShort.textContent = shorten(connectedAddress);
  connectBtn.classList.add("hidden");
  walletChip.classList.remove("hidden");
  appPanel.classList.remove("disabled");
  lockedMsg.classList.add("hidden");
  panelContent.classList.remove("hidden");
  fetchBalance();
  renderDebts();
  updateStats();
  checkSharedIou();
}

function shorten(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// ---------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------
async function fetchBalance() {
  balanceValue.textContent = "…";
  try {
    const response = await fetch(`${HORIZON_URL}/accounts/${connectedAddress}`);
    if (!response.ok) {
      balanceValue.textContent = "0 (unfunded)";
      return;
    }
    const account = await response.json();
    const native = account.balances.find((b) => b.asset_type === "native");
    balanceValue.textContent = native ? Number(native.balance).toFixed(4) : "0";
  } catch (err) {
    console.error(err);
    balanceValue.textContent = "error";
  }
}

// ---------------------------------------------------------------------
// Stats + nudge rotation
// ---------------------------------------------------------------------
function updateStats() {
  const unsettled = debts.filter((d) => !d.settled);
  const totalUnpaid = unsettled.reduce((sum, d) => sum + (d.total - d.paid), 0);
  totalUnpaidXlmEl.textContent = totalUnpaid.toFixed(4);
  totalUnpaidPhpEl.textContent = (totalUnpaid * XLM_TO_PHP).toFixed(0);
}

let nudgeIndex = 0;
function rotateNudge() {
  const unsettled = debts.filter((d) => !d.settled);
  if (unsettled.length === 0) {
    nudgeText.textContent = "Walang utang na naka-pending. 🎉";
    return;
  }
  const debt = unsettled[nudgeIndex % unsettled.length];
  const template = NUDGES[nudgeIndex % NUDGES.length];
  const remaining = (debt.total - debt.paid).toFixed(2);
  nudgeText.textContent = template.replace("{name}", debt.name).replace("{amount}", remaining);
  nudgeIndex++;
}
setInterval(rotateNudge, 4000);

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    renderDebts();
  });
});

// ---------------------------------------------------------------------
// Add debt
// ---------------------------------------------------------------------
addDebtForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const debt = {
    id: makeId(),
    name: debtNameInput.value.trim(),
    address: debtAddressInput.value.trim(),
    total: Number(debtAmountInput.value),
    paid: 0,
    settled: false,
    history: [],
  };
  debts.push(debt);
  saveDebts();
  addDebtForm.reset();
  document.querySelector(".add-debt").removeAttribute("open");
  renderDebts();
  updateStats();
  rotateNudge();
});

// ---------------------------------------------------------------------
// Render debt list
// ---------------------------------------------------------------------
function renderDebts() {
  const filtered = debts.filter((d) => (activeTab === "settled" ? d.settled : !d.settled));
  debtListEl.innerHTML = "";
  emptyState.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((debt) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector(".debt-card");
    card.dataset.id = debt.id;

    node.querySelector(".debt-name").textContent = debt.name;
    node.querySelector(".debt-address").textContent = shorten(debt.address);

    const remaining = debt.total - debt.paid;
    const pct = debt.total > 0 ? Math.min(100, (debt.paid / debt.total) * 100) : 0;
    node.querySelector(".progress-fill").style.width = `${pct}%`;
    node.querySelector(".debt-remaining").textContent = `${remaining.toFixed(4)} XLM left`;
    node.querySelector(".debt-total-sub").textContent = `of ${debt.total.toFixed(4)} XLM (~₱${(remaining * XLM_TO_PHP).toFixed(0)})`;

    const payInput = node.querySelector(".pay-amount-input");
    payInput.value = remaining.toFixed(4);
    payInput.max = remaining;

    const payBtn = node.querySelector(".pay-btn");
    if (debt.settled) {
      payBtn.disabled = true;
      payBtn.textContent = "Settled ✓";
      payInput.disabled = true;
    }
    payBtn.addEventListener("click", () => settleDebt(debt.id, Number(payInput.value)));

    node.querySelector(".share-btn").addEventListener("click", (e) => toggleShareBox(e.target, debt));
    node.querySelector(".history-toggle").addEventListener("click", (e) => toggleHistory(e.target, debt));

    debtListEl.appendChild(node);
  });
}

// ---------------------------------------------------------------------
// Share IOU (link + QR)
// ---------------------------------------------------------------------
function buildShareLink(debt) {
  const url = new URL(window.location.href.split("?")[0]);
  url.searchParams.set("pay", debt.address);
  url.searchParams.set("amount", (debt.total - debt.paid).toFixed(4));
  url.searchParams.set("name", debt.name);
  url.searchParams.set("debtId", debt.id);
  return url.toString();
}

function toggleShareBox(button, debt) {
  const card = button.closest(".debt-card");
  const box = card.querySelector(".share-box");
  box.classList.toggle("hidden");
  if (box.classList.contains("hidden")) return;

  const link = buildShareLink(debt);
  const qrImg = box.querySelector(".qr-img");
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(link)}`;
  const linkInput = box.querySelector(".share-link");
  linkInput.value = link;

  const copyBtn = box.querySelector(".copy-link-btn");
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
  };
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
function toggleHistory(button, debt) {
  const card = button.closest(".debt-card");
  const box = card.querySelector(".history-box");
  box.classList.toggle("hidden");
  if (box.classList.contains("hidden")) return;

  const list = box.querySelector(".history-list");
  list.innerHTML = "";
  if (debt.history.length === 0) {
    list.innerHTML = `<p class="history-empty">No payments yet.</p>`;
    return;
  }
  debt.history
    .slice()
    .reverse()
    .forEach((h) => {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML = `<span>${new Date(h.date).toLocaleDateString()} · ${h.amount.toFixed(4)} XLM</span>
        <a href="https://stellar.expert/explorer/testnet/tx/${h.hash}" target="_blank" rel="noopener">view ↗</a>`;
      list.appendChild(row);
    });
}

// ---------------------------------------------------------------------
// Settle (send payment) — used by both debt cards and the shared IOU banner
// ---------------------------------------------------------------------
async function settleDebt(debtId, amount) {
  const debt = debts.find((d) => d.id === debtId);
  if (!debt) return;
  const remaining = debt.total - debt.paid;
  if (amount <= 0 || amount > remaining + 0.0000001) {
    showResult("error", "Enter a valid amount (not more than what's left).");
    return;
  }

  showResult("pending", "Building transaction…");
  try {
    const server = getServer();
    const sourceAccount = await server.loadAccount(connectedAddress);

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: debt.address,
          asset: StellarSdk.Asset.native(),
          amount: amount.toFixed(7),
        })
      )
      .setTimeout(180)
      .build();

    showResult("pending", "Waiting for your approval in Freighter…");
    const signResult = await freighterApi.signTransaction(transaction.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: connectedAddress,
    });
    if (signResult.error) throw new Error("Transaction was declined in Freighter.");

    showResult("pending", "Submitting to the Stellar network…");
    const signedTransaction = StellarSdk.TransactionBuilder.fromXDR(signResult.signedTxXdr, NETWORK_PASSPHRASE);
    const submitResult = await server.submitTransaction(signedTransaction);

    debt.paid += amount;
    debt.history.push({ hash: submitResult.hash, amount, date: Date.now() });
    const justSettled = debt.paid >= debt.total - 0.0000001;
    if (justSettled) debt.settled = true;
    saveDebts();

    showResult(
      "success",
      `✅ ${justSettled ? "Fully settled!" : "Partial payment sent!"}<br>Hash: ${submitResult.hash}<br><a href="https://stellar.expert/explorer/testnet/tx/${submitResult.hash}" target="_blank" rel="noopener">View on Stellar Expert ↗</a>`
    );

    if (justSettled) fireConfetti();
    renderDebts();
    updateStats();
    rotateNudge();
    fetchBalance();
  } catch (err) {
    console.error(err);
    const message = err?.response?.data?.extras?.result_codes
      ? JSON.stringify(err.response.data.extras.result_codes)
      : err.message || "Something went wrong.";
    showResult("error", `❌ Transaction failed.<br>${message}`);
  }
}

function showResult(kind, html) {
  resultPanel.className = `result-panel ${kind}`;
  resultPanel.innerHTML = html;
  resultPanel.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Shared IOU link handling
// ---------------------------------------------------------------------
function checkSharedIou() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("pay")) return;

  sharedIouParams = {
    address: params.get("pay"),
    amount: Number(params.get("amount")),
    name: params.get("name") || "someone",
    debtId: params.get("debtId"),
  };

  iouDesc.textContent = `${sharedIouParams.name} is asking for ${sharedIouParams.amount.toFixed(4)} XLM.`;
  iouBanner.classList.remove("hidden");
}

iouPayBtn.addEventListener("click", async () => {
  if (!sharedIouParams) return;
  showResult("pending", "Building transaction…");
  try {
    const server = getServer();
    const sourceAccount = await server.loadAccount(connectedAddress);
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: sharedIouParams.address,
          asset: StellarSdk.Asset.native(),
          amount: sharedIouParams.amount.toFixed(7),
        })
      )
      .setTimeout(180)
      .build();

    const signResult = await freighterApi.signTransaction(transaction.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: connectedAddress,
    });
    if (signResult.error) throw new Error("Transaction was declined in Freighter.");

    const signedTransaction = StellarSdk.TransactionBuilder.fromXDR(signResult.signedTxXdr, NETWORK_PASSPHRASE);
    const submitResult = await server.submitTransaction(signedTransaction);

    showResult(
      "success",
      `✅ Paid ${sharedIouParams.name}!<br>Hash: ${submitResult.hash}<br><a href="https://stellar.expert/explorer/testnet/tx/${submitResult.hash}" target="_blank" rel="noopener">View on Stellar Expert ↗</a>`
    );
    fireConfetti();
    iouBanner.classList.add("hidden");
    fetchBalance();
  } catch (err) {
    console.error(err);
    showResult("error", `❌ Payment failed.<br>${err.message || "Something went wrong."}`);
  }
});

// ---------------------------------------------------------------------
// Confetti (lightweight, no library)
// ---------------------------------------------------------------------
function fireConfetti() {
  const colors = ["#E8A33D", "#4ADE80", "#EAEFF7", "#f0b155"];
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${1.5 + Math.random() * 1.5}s`;
    piece.style.animationDelay = `${Math.random() * 0.3}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3200);
  }
}

// ---------------------------------------------------------------------
// Wire up top-level buttons
// ---------------------------------------------------------------------
connectBtn.addEventListener("click", connectWallet);
disconnectBtn.addEventListener("click", disconnectWallet);
refreshBtn.addEventListener("click", fetchBalance);
