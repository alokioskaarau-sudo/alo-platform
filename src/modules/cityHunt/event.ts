export const cityHuntEvent = {
  slug: "aarau-10k-001",
  title: "ALO CITY HUNT — 10K EDITION",
  city: "Aarau",
  baseAddress: "Zwischen den Toren 14, 5000 Aarau",
  status: "DRAFT",
  registrationOpen: false,
  startsAt: null,
  endsAt: null,
  currency: "CHF",
  cashPrizes: [
    { key: "main", label: "Hauptquest", amountRappen: 25000, count: 1 },
    { key: "silver", label: "Silber-Schätze", amountRappen: 5000, count: 3 },
    { key: "mini", label: "Kleine Geldfunde", amountRappen: 1000, count: 10 },
  ],
} as const;

export const cashBudgetRappen =
  cityHuntEvent.cashPrizes.reduce(
    (total, prize) => total + prize.amountRappen * prize.count,
    0
  );

if (cashBudgetRappen !== 50000) {
  throw new Error("City Hunt: Preisplan muss CHF 500 ergeben.");
}
