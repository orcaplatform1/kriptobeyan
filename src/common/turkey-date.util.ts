// Borsalardan/zincirden gelen ham zaman damgalari HEP UTC'dir (Binance,
// Bybit, Etherscan vb.). Turkiye vergi mevzuati ve TCMB kurlari ise TSI
// (UTC+3, 2016'dan beri DST yok — yil boyu sabit) bazli calisir. Bir UTC
// aninin HANGI Turkiye takvim gunune/yilina denk geldigini bulmak icin once
// +3 saat kaydirip UTC alanlarini okumak gerekir — aksi halde 21:00-23:59
// UTC'deki bir islem (Turkiye'de zaten ertesi gunun 00:00-02:59'u) bir
// onceki gunun/yilin TCMB kuruyla eslesir ya da YANLIS vergi yilina
// bucketlanir (bkz. TcmbClient, PriceDataService, TaxCalculationService).
const TURKEY_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Verilen UTC anini, Turkiye takvim gununun UTC-gece-yarisina kaydirir. */
export function toTurkeyDate(date: Date): Date {
  return new Date(date.getTime() + TURKEY_OFFSET_MS);
}

/** Verilen UTC aninin Turkiye takviminde hangi yila denk geldigi. */
export function getTurkeyYear(date: Date): number {
  return toTurkeyDate(date).getUTCFullYear();
}
