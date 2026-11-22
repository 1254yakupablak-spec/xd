# KOKLEYİCİ SPORTS

Bu eklenti 6q'da **Spor › Özel Oranlar (Goal Mix)** sayfasına bir kupon oluşturucu ekler. Goal Mix'te 2–5 maç seçilir ve seçilen maçların 90 dakikadaki toplam golüne tek bir Alt/Üst oynanır. Eklenti, bu listedeki maçlardan adil orana göre değeri en yüksek kuponları önerir.

## Nasıl hesaplar

6q'nun herhangi bir sayfası açıkken eklenti 10 dakikada bir arka planda önümüzdeki 48 saatteki bütün Goal Mix maçlarını toplar. Her maçın adil gol beklentisini ve Goal Mix'in varsaydığı gol beklentisini kendi içinde saklar. Kupon penceresi bu hazır veriyi seçimlerine göre filtreler. O an sadece seçilen kombinasyonların gerçek oranını sorar, bu yüzden kuponlar birkaç saniyede çıkar. Pencerede **Verileri yenile** düğmesi toplamayı hemen yeniden başlatır.

1. Goal Mix listesindeki maçları sitenin normal futbol bültenindeki maçlarla eşleştirir. Eşleştirmede maç saatine ve takım adlarına bakar.
2. Her maçın normal "Alt/Üst" oranlarından (6q'nun bülteni) site payını çıkarır ve maçın adil gol beklentisini bulur: 1.5–4.5 arası dengeli çizgilerin her birinden Poisson ile beklenti çıkar, ortancası alınır.
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
   - **En az çizgi** ve **en çok çizgi** (boş = sınırsız; örn. Alt + en az 5.5 → sadece 5.5 ve üstü Alt kuponlar)
   - **Maç sayısı:** en az – en çok (2–10, Goal Mix'in izin verdiği kadar)
   - **Başlama aralığı:** 6–48 saat
   - **Kupon sayısı**
   - **Lig:** çoklu seçimli liste, aramalı (boş = bütün ligler)
   - **Aynı maç:** Tekrarlı (bir maç birden çok kuponda olabilir), Tekrarsız (her maç en fazla bir kuponda) ya da Ters çizgi (bir maç en fazla bir Üst ve bir Alt kuponda, aynı yönde iki kez değil)
4. **Kuponları oluştur**a bas. Kuponlar çıktıktan sonra üstteki **Sırala** çubuğuyla olasılığa, değere, orana, maç sayısına ya da saate göre sıralanır.
5. Kuponlar solda liste halinde; bir kupona basınca sağ panelde yorumu ve maç tablosu (saat, maç, beklenen gol, son 5 maç) görünür.
6. Üstteki **Kupon seti** paneli seçili kuponlardan en az 1, en az 2… tanesinin tutma olasılığını gösterir (ortak maçlar birlikte sayılır, 20.000 deneme). Kupondaki kutucukla kupon sete katılır / çıkarılır.

Not: Veri hazırsa kuponlar birkaç saniyede çıkar; ilk açılışta toplama 10–30 saniye sürer.

## Favoriler

Her kuponun yanındaki ☆ ile kupon favorilere kaydedilir (bu tarayıcıda). Üstteki **Favoriler** sekmesinde kaydedilen kuponlar aynı liste ve ayrıntı görünümünde durur; seçili favoriler için birlikte tutma olasılığı (en az 1, en az 2…) ve kupon başı tutara göre kâr/zarar hesaplanır. Maçı başlamış kuponlar işaretlenir, **Geçmiş maçlıları temizle** ile silinir.

## Kurulum

1. `chrome://extensions` sayfasını aç ve **Geliştirici modu**nu aç.
2. **Paketlenmemiş öğe yükle**ye bas ve bu `kupon-skor` klasörünü seç.

## Güncelleme

1. Eklenti menüsünden **Güncellemeleri denetle**ye, sonra **Güncelle**ye bas.
2. Uzantılar sayfasında eklentiyi yenile.
