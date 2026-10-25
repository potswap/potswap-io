export function toRaw(amount: number | string, decimals: number): string {
  const [i = '0', f = ''] = String(amount).replace(/,/g, '.').split('.')
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals)
  return (BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString()
}
export const fromRaw = (raw: string | number | bigint, decimals: number) => Number(BigInt(raw)) / 10 ** decimals
export const explorer = (sig: string) => `https://solscan.io/tx/${sig}`
