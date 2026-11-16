# KOKLEYİCİ SPORTS

Bu eklenti 6q'da **Spor › Özel Oranlar (Goal Mix)** sayfasına bir kupon oluşturucu ekler. Goal Mix'te 2–5 maç seçilir ve seçilen maçların 90 dakikadaki toplam golüne tek bir Alt/Üst oynanır. Eklenti, bu listedeki maçlardan adil orana göre değeri en yüksek kuponları önerir.

## Nasıl hesaplar

1. Goal Mix listesindeki maçları sitenin normal futbol bültenindeki maçlarla eşleştirir. Eşleştirmede maç saatine ve takım adlarına bakar.
2. Her maçın normal "Alt/Üst" oranlarından site payını çıkarır ve maçın adil gol beklentisini bulur.
3. Goal Mix'in fiyat servisinden, sitenin aynı maç için varsaydığı gol beklentisini çıkarır.
4. Bu iki beklenti arasındaki farkın en büyük olduğu maçlardan kombinasyonlar kurar. Her kombinasyonun gerçek Goal Mix oranını sorar. Toplam gol için Poisson dağılımı varsayarak bu oranı adil olasılıkla karşılaştırır.
5. Seçilen oran aralığında değeri en yüksek kuponları gösterir. Değer şöyle hesaplanır: adil olasılık × sitenin oranı − 1.

Eklenti bahis yapmaz ve siteye hiçbir şey göndermez. Önerilen maçları Goal Mix listesinden kendin eklersin. Adil oran bir tahmindir, kazanç garantisi değildir.

## Kullanım

1. Goal Mix sayfasını aç (6q › Spor › Özel Oranlar).
2. Sağ alttaki **Kupon oluşturucu** düğmesine bas.
3. Ayarları seç:
   - **Alt / Üst:** Üst, Alt ya da İkisi
   - **En az oran** ve **en çok oran**
   - **Maç sayısı:** 2–5
   - **Başlama aralığı:** 6–48 saat
   - **Kupon sayısı**
4. **Kuponları oluştur**a bas. Hesaplama 10–40 saniye sürer.

## Kurulum

1. `chrome://extensions` sayfasını aç ve **Geliştirici modu**nu aç.
2. **Paketlenmemiş öğe yükle**ye bas ve bu `kupon-skor` klasörünü seç.

## Güncelleme

1. Eklenti menüsünden **Güncellemeleri denetle**ye, sonra **Güncelle**ye bas.
2. Uzantılar sayfasında eklentiyi yenile.
