# KOKLEYİCİ SPORTS

6q'daki Bahislerim sayfasında, kuponlardaki futbol maçlarının skorunu, dakikasını, tarihini ve saatini
gösterir. "TOPLAM GOL 10.5 ÜST/ALT" gibi kuponlarda toplam golü hesaplar ve kuponun tutup tutmadığını
bir çubukla gösterir.

## Kurulum

1. Chrome'da `chrome://extensions` adresini aç.
2. Sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle**ye tıkla ve bu `kupon-skor` klasörünü seç.
4. Bahislerim sayfasını aç. Filtre çubuğundaki rozet kırmızıysa **SofaScore'u aç** düğmesine bas.
   Arka planda "Kupon Skor" sekme grubunda bir SofaScore sekmesi açılır, rozet birkaç saniyede yeşile döner.

Kodda değişiklik olursa `chrome://extensions` sayfasında eklentinin yenile (↻) düğmesine bas ve
sayfaları yenile.

## Eklenti menüsü

Araç çubuğundaki eklenti simgesine tıklayınca açılır (simge görünmüyorsa yapboz simgesinden sabitle):
- **Canlı skor**, **Arbitraj**: ayrı ayrı açılıp kapatılır.
- **Siteler**: her sitenin durumu (yeşil nokta bağlı) ve kaç maç/oran okunduğu; bağlı değilse **Aç** düğmesi çıkar.
- **Ayarlar** (kapalı bölüm): 1xBet adresi, Odds API anahtarı, öğrenilenler.
- **Skor kaynağı**: SofaScore ya da Livescore. Maçlar her durumda SofaScore üzerinden bulunur (elle bağlama ve
  "SofaScore'da bul" aynen çalışır). Livescore seçilirse skor, dakika ve durum aynı maçın livescore.in'deki
  karşılığından gösterilir: canlı maçlar açık Livescore sekmesinin ekranından (10 sn'de bir okunur), diğerleri
  sitenin veri adresinden. Livescore'da bulunamayan maçta SofaScore'un skoru gösterilir. Kupon satırının altında
  "skor: Livescore" yazar; maça tıklamak livescore.in'deki maç sayfasını açar. Livescore sekmesi açık kalmalı
  ve bugünün futbol listesinde (www.livescore.in/tr/) durmalı.
- **SofaScore**, **1xBet**, **Stake**: sekme bağlı mı, son güncelleme, kaç maç/oran okunduğu ve sekmeyi açan düğme.
- **1xBet adresi**: 1xBet'in ayna adresini kullanıyorsan (ör. `1xbet-tr.com` ya da adında 1xbet geçmeyen bir
  adres) 1xBet bölümündeki kutuya yaz, **Kaydet**. Linkin tamamı da yapıştırılabilir, sadece alan adı alınır.
  "1xBet'i aç" bu adresi açar ve eklenti bu adresteki sekmeden oranları okur. Adresi kaydettikten sonra açık
  1xBet sekmesini bir kez yenile. Boş bırakıp kaydedersen `1xbet.com`'a döner. Adında "1xbet" geçen adresler
  (`1xbet1234.com` gibi) zaten kendiliğinden tanınır.
- **Öğrenilenler**: aşağıda "Öğrenilenleri paylaşma" bölümüne bak.

## Adres değişirse

Eklenti belirli bir adrese bağlı değil. 6q'nun ayna adresi ya da içindeki bahis sağlayıcısının adresi
(şu an `play.bonuseblb.com`) değişse de çalışır: her sitede yüklenir ama sadece sayfada bu sitenin
Bahislerim filtre çubuğu ya da Özel Oranlar kartları görülünce devreye girer. Başka sitelerde iki saniyede
bir bu seçiciye bakmaktan başka bir şey yapmaz; sayfayı okumaz, bir şey eklemez, veri göndermez. Her sitede
yüklendiği için Chrome kurulumda "tüm sitelerdeki verileri okuyabilir" izni gösterir.

Site sayfalarının HTML yapısını (sınıf adlarını) değiştirirse eklenti sayfayı tanımayabilir;
o zaman filtre çubuğundaki rozet ve kartlardaki satırlar görünmez.

**Yeni 6q sayfası (6q.net/sportsbook):** Spor bölümü artık çerçevede değil, 6q'nun kendi sayfasında ve shadow DOM
içinde. Özel Oranlar kartları (`sb-custom-bet-card`) tanınır; satırlar kartın sağ sütununda, "Kupona ekle"nin altında
ve sitenin renkleriyle çizilir. Bu kartlarda maç saati yazmadığı için saat kontrolü yapılmaz (maç 4 saat öncesi ile
36 saat sonrası arasında olmalı) ve esnek eşleşme kullanılmaz. Üç maçlık kartlar atlanır, onlara bir şey eklenmez. Yeni Bahislerim sayfasında
tek maçlık kartın skorunu site kendisi gösterir; çok maçlı özel oranlarda maçlar kartın içine sitenin maç kutularıyla eklenir
(skor, dakika, toplam gol). Kartın üstünde toplam gole göre Alt/Üst durumu yazar (Tuttu, Tutmadı, Devam ediyor); çizgi kartta olmadığı için
Özel Oranlar'dan öğrenilir, eklenti o kuponu orada görmediyse "Çizgi bilinmiyor" yazar. Maç bulunamazsa ya da yanlışsa satırdaki düğmeyle düzeltilir. Eski sağlayıcı sayfası çalışmaya devam eder.

## Nasıl çalışır

- **6q'ya hiç istek atılmaz.** Eklenti 6q'da sadece ekranda görünen kupon kartlarını okur.
- **Veri SofaScore sekmesinden gelir** (`sofa.js`). Bu sekme:
  - 20 saniyede bir canlı futbol maçlarını,
  - en sık 30 dakikada bir (ya da kuponda bulunamayan maç olunca, en sık 10 dakikada bir)
    dün, bugün ve yarının bütün maçlarını çeker. İstekler 3'er 3'er ve araya beklemeyle gider.
  - Veriyi Chrome'un eklenti deposuna yazar, kupon sayfası oradan okur.
- SofaScore sekmesi kapalıysa skorlar güncellenmez; rozet kırmızıya döner.
- Arka plandaki sekmelerin zamanlayıcıları Chrome tarafından yavaşlatılabilir. Genelde sorun olmaz ama dakikalar bazen biraz gecikebilir.

## Görünüm

- **Kuponun kendisine dokunulmaz.** Her kartın en altına ayrı bir **Maç takibi** bölümü eklenir.
- Bölümde her maç, sitenin kendi bacak kartı biçiminde gösterilir: tarih, saat, logolar, skor kutusu,
  dakika/MS rozeti. Karta tıklamak maçı SofaScore'da açar. "TOPLAM GOL" kuponlarında altta toplam gol
  çubuğu var.
- Özel kuponlarda ("A-B I C-D I E-F") başlıktaki bütün maçlar, normal kuponlarda futbol bacakları listelenir.
- Filtre çubuğunda tek bir SofaScore durum rozeti var.

## Eşleştirme (sırasıyla)

1. **Elle bağlanan maç** ("Yanlış maç?" ile).
2. **Yazıdan eşleşme**: kısaltmalar ("R.MADRID", "S.GRAZ", "PSG", "AZ"), Türkçe yazımlar ("MARSILYA",
   "KOPENHAG"), "-spor" ekleri, yedek/kadın takımları dikkate alınır. İki takım da yeterince tutmalı.
3. **SofaScore araması**: yazıdan bulunamazsa iki takım SofaScore'un aramasında aranır; ilk takımın
   son/sıradaki maçlarında rakibi ikinci aramada çıkan maç bulunur, kupon saatinden sonraki ilk maç
   seçilir. Örn. "SANTANDER-R.MADRID" → Real Racing Club - Real Madrid.
4. Hiçbiri olmazsa satırda "Maç bulunamadı" ve **Link ekle** çıkar.

Elle bağladığın maçtan iki takım yazısı da öğrenilir ("SANTANDER" = Real Racing Club); aynı yazı
başka kuponda geçerse doğrudan tanınır.

## Özellikleri açıp kapatma

Menüdeki **Özellikler** bölümünden ikisi ayrı ayrı açılıp kapatılır, açık sayfalara anında yansır:
- **Canlı skor**: Bahislerim'deki "Maç takibi" bölümleri ve filtre çubuğundaki SofaScore rozeti.
- **Arbitraj**: Özel Oranlar kartlarındaki 1xBet / Stake satırları.

## Özel Oranlar arbitrajı

6q'nun Özel Oranlar kartlarının (spor ana sayfası ve Özel Oranlar sekmesi) altına 1xBet ve Stake'teki
ters oran ve kâr yüzdesi eklenir:
- Sadece **tek maçlık** gol Alt/Üst kartları: maçın toplam golü ("Toplam Gol 2.5") ve **tek takımın**
  golü ("Ev Sahibi / Deplasman / Takım 1 / <takım adı> Toplam Gol 1.5") ve **karşılıklı gol** (KG Var / Yok).
  Kombineler atlanır; devre, korner, kart, "KG ve Toplam" gibi diğer pazarlar "desteklenmiyor" yazar. Kart
  ekrandan okunur (6q'ya istek yok).
- Karşılıklı golde ters taraf aynı maçın karşı seçeneğidir: KG Var ↔ KG Yok. 1xBet'te bu oran genelde maç
  sayfasında gelir (otomatik arama hazırsa kendiliğinden çekilir); Stake'te aramayla birlikte gelir.
- Takım golünde takım, pazardaki yazıdan (Ev sahibi/Deplasman) ya da yazılan takım adının kartın başında mı
  sonunda mı olduğundan, olmazsa sitedeki takım adlarına benzerliğinden bulunur. Bulunamazsa satırda
  "hangi takım belli değil" yazar.
- Ters taraf: Alt ↔ Üst, aynı çizgi (takım golünde aynı takımın). Kâr % = (1 / (1/6q oranı + 1/ters oran) − 1) × 100.
- Takım golü oranları 1xBet'te genelde sadece maç sayfasında gelir: satırda "... yok" yazıyorsa maçı 1xBet'te
  bir kez aç. Stake'te maçın arama sonucunda takım toplamı gelmiyorsa maç sayfasını açmak gerekebilir.
  Yeşil **+%** arbitraj var, kırmızı **−%** yok. Satıra tıklayınca tutar hesabı açılır.
- **1xBet**: 1xBet kendi sayfası dışından gelen isteklere 403 verdiği için eklenti 1xBet'e istek atmaz;
  açık 1xBet sekmesinin zaten aldığı maç listesi ve maç oranı yanıtlarını okur. Bu yüzden **1xBet sekmesi
  maç öncesi futbol listesinde** (`/tr/line/football`) açık kalmalı. Bir maçın 2.5 oranı listede yoksa o
  maçı 1xBet'te bir kez açmak yeterli.
- **Stake**: Stake'in futbol sayfası maçları sekmelere böldüğü için açık Stake sekmesi, Özel Oranlar'daki
  her maçı Stake'in kendi arama sorgusuyla arar; tek istekte maçın "Goller" sekmesi (bütün Alt/Üst çizgileri,
  takım toplamları, karşılıklı gol) gelir. Bulunan maçlar 3 dakikada bir tazelenir. Sadece gerçek futbol alınır
  (FIFA/e-spor ve simülasyon elenir).
- **Stake'te aranan kelimeler**: Stake'in araması yazımı birebir ister ("Beşiktaş" bulur, "Besiktas" bulmaz;
  "Brondby" bulur, "Brøndby" bulmaz) ve uzun resmi adı bulmaz ("Galatasaray Spor Kulübü"). Bu yüzden takımı
  belirleyen tek kelimeler hem asıl yazımıyla hem sade hâliyle aranır; "Spor", "Kulübü", "FC" gibi kelimeler
  aranmaz. Sıra: SofaScore'da ve 1xBet'te bulunmuş maçın adları, öğrenilmiş adlar, kartın en nadir kelimeleri,
  takım adları tablosundaki İngilizce yazım ("København" → "copenhagen").
- **Eşleştirme**: Maç saati ±20 dk tutmalı, maç 4 saat öncesi ile 36 saat sonrası arasında olmalı (rövanş vb.
  başka gündeki maç seçilmez). Kartta U19/U21/II/B ya da kadın takımı yazmıyorsa böyle maçlarla asla
  eşleştirilmez (aynı adlı gençler maçı sahte bir "arbitraj" gösterirdi).
- **Takım adları tablosu** (`teams.json`): Wikidata'dan alınmış ~14 bin kulübün bütün adları ve takma adları
  (ör. FC København = FC Copenhagen = F.C. Kopenhag; PSV = Philips Sport Vereniging). Kart yazısında bir kulübün
  adı geçerse o kulübün diğer adları da aranır. Aynı ad ikiden çok kulübe aitse ya da tek kelime ve kısaysa
  kullanılmaz. Kupon takım yazıları ("KOPENHAG", "MARSILYA") için de kullanılır.
- **Livescore (livescore.in)**: Menüden **Livescore'u aç** ile "Kupon Skor" grubunda bir sekme açılır; dün/bugün/yarının
  futbol maçlarını (~800) sitenin kendi veri adresinden 30 dakikada bir okur (3 istek). Adları İngilizce ve sade
  ("Sonderjyske - FC Copenhagen", "Genclerbirligi"); SofaScore'la birlikte ikinci ad kaynağıdır ve Stake'in
  aramasında ilk denenen adlardır. Satırda "Livescore adlarıyla bulundu" yazabilir.
- **SofaScore köprüsü**: Kart önce SofaScore'un dün/bugün/yarın listesinde bulunur (adları kısa ve düzgün:
  "Mallorca", "Kayserispor"); bulunursa 1xBet ve Stake'te bu adlarla da aranır, 1xBet otomatik araması da
  önce bu adları dener. Satırda "SofaScore adlarıyla bulundu" yazar.
- **Sıradan kelimeler az sayılır**: "Real", "United", "Sporting", "FC" gibi pek çok takımda geçen kelimeler
  takımı belirlemez; kart "Real Madrid" iken "Real Sociedad" eşleşmez.
- **Esnek eşleşme**: İki takım da yeterince tutmazsa, kart saatinde (±20 dk) bir takımı tam, diğerini kısmen
  tutan **tek** bir maç varsa o alınır. Aynı saatte birden çok aday varsa hiçbiri alınmaz. Bu satırlarda
  turuncu "esnek eşleşme, kontrol et" yazar.
- **Bulunan maçın kimliği**: Her satırın altında sitedeki takım adları, lig, tarih-saat, Erkek/Kadın ve
  varsa Gençler/Yedek yazar. Kartla uyuşmayan bilgi (saat farkı, kartta olmayan kadın/gençler maçı) turuncu
  gösterilir; yanlış maçsa **Maç seç** ile düzelt.
- **Maç bulunamayınca**: Satırda **1xBet'e git** / **Stake'e git** çıkar. Site açılır; maçın sayfasını aç, üstte "bu maç mı?"
  çubuğu çıkar (sitedeki takımlar, tarih-saat, lig). **Bağla** ile maç karta bağlanır, oranlar gelir ve iki takımın adı öğrenilir:
  adlar hiç benzemese de aynı takım başka gün kendiliğinden bulunur. Öğrenilen ad bütün sitelerde ve kuponlarda kullanılır.
  Yanlış eşleşen satırda **Değiştir** aynı yolu açar, elle bağlanmış satırda **Kaldır** bağlantıyı siler.
  Maçı sitede kendin bulup açtıysan da çubuk çıkar: maç henüz bir karta bağlı değilse bulunamayan kartlar listelenir (en benzeyen önce), seçip **Bağla**'ya basarsın.
- **Siteler arası öğrenme**: Maç bir sitede kesin bulunduysa (elle ya da iki takım da tutarak), diğer sitede o
  sitenin takım adlarıyla da aranır; satırda "1xBet adlarıyla bulundu" yazar. Bu maçtan kart yazısının
  parçaları diğer site için de öğrenilir. Stake araması da 1xBet'teki ve öğrenilmiş takım adlarıyla yapılır.
- Sekme yoksa satırda ve menüde **1xBet'i aç** / **Stake'i aç** düğmesi çıkar.
- Oranlar bahsi yaptığın ana kadar değişebilir; bahis şirketleri arbitraj yapan hesapları
  limitleyebilir ya da bu bahisleri iptal edebilir.

## Bilgi şeridi

Özel Oranlar kartlarının üstünde her sitenin oranının son geldiği saat, **Yenile** bağlantısı ve "oynamadan önce kontrol et"
uyarısı durur. **Yenile** sayfayı değil oranları yeniler: 1xBet ve Stake sekmeleri kartların maçlarını yeniden sorgular. Hız sınırı
aynı kaldığı için hepsi bir iki dakikada tamamlanır.

## Öğrenilenleri paylaşma

Menüdeki **Öğrenilenler** bölümü: kupon takım adları, arbitraj takım adları ve elle bağlanan maçların sayısı.
- **Dışa aktar**: hepsini `learned.json` dosyasına indirir.
- **İçe aktar**: bir `learned.json` dosyasındakileri ekler. Kendi kayıtların değişmez, sadece eksikler eklenir.
- Eklenti klasöründe `learned.json` varsa kurulumda ve her güncellemede kendiliğinden içe aktarılır. Arkadaşına
  göndereceğin pakete kendi `learned.json` dosyanı koyarsan senin öğrendiklerinle başlar.

## Yanlış maç / maç bulunamadı

Her satırda **Yanlış maç?** (bulunamayanlarda **Link ekle**) düğmesi var.

**Kolay yol (SofaScore'da bul):**
1. Düğmeye bas, açılan kutuda **SofaScore'da bul**'a bas. SofaScore yeni sekmede açılır.
2. SofaScore'da maçı ara ve maçın sayfasını aç. Sayfanın üstünde "Kupondaki X bu maç mı?" çubuğu çıkar
   (maçın takımları, tarihi ve ligiyle).
3. Doğru maçsa **Bağla**'ya bas, sonra **Kupona dön**. Yanlışsa başka maça geç; çubuk o maçı sorar.
   Bekleyen istek 30 dakika sonra düşer.

**Link ile:**
1. SofaScore'da doğru maçı aç.
2. Adres çubuğundaki linkin tamamını kopyala (sonu `#id:12345678` ile biter).
3. Düğmeye bas, linki yapıştır, **Kaydet**.

Bu bağlantı kalıcıdır; aynı yazı başka kuponda geçerse de o maç kullanılır. Geri almak için düğmeye
tekrar basıp **Elle bağlamayı kaldır, otomatiğe dön**'ü seç.

## Yeni kısaltma eklemek

`content.js` içinde iki sözlük var:
- `PHRASE_ALIAS`: kupondaki yazının tamamı → takım adındaki kelimeler (`'r madrid': 'real madrid'`).
- `WORD_ALIAS`: tek kelime → karşılığı (`marsilya: 'marseille'`).
Yazılar küçük harf, Türkçe karakterler sadeleşmiş ve noktalar boşluğa çevrilmiş olarak yazılır.

## Dosyalar

- `manifest.json`: eklenti tanımı.
- `content.js`, `styles.css`: Bahislerim sayfasındaki panel, filtre rozeti ve eşleştirme.
- `sofa.js`: SofaScore sekmesinde veri toplayıcı.
- `livescore.js`: livescore.in sekmesinde maç listesi (takım adları) ve canlı skor toplayıcı.
- `oddsapi.js`: Odds API istekleri (arka planda, sadece anahtar girildiyse).
- `feed-hook.js`: 1xBet ve Stake sayfalarının içinde, sayfanın aldığı yanıtların kopyasını iletir
  (diğer sitelerde hiçbir şey yapmaz).
- `xbet.js`, `stake.js`: bu yanıtlardan (Stake için ayrıca kendi aramasıyla) maçları ve Alt/Üst oranlarını kaydeder.
- `bar.js`: SofaScore ve 1xBet sayfalarının üstündeki "bu maç mı?" çubuğu.
- `teams.json`: takım adları tablosu (Wikidata, CC0).
- `background.js`: veri sekmelerini açan/yenileyen, kurulumda `learned.json`ı içe aktaran arka plan betiği.
- `learned.js`: öğrenilenleri birleştirme (menü ve arka plan kullanır); `learned.json`: paylaşılan öğrenilenler (isteğe bağlı).
- `popup.html`, `popup.css`, `popup.js`: eklenti menüsü.

## Çok maçlı özel oranlar

- **Çizgi kaydı:** "ÜÇ MAÇ TOPLAM GOL 10.5 ÜST" gibi çizgiler kart Özel Oranlar'dayken ya da site kupon listesini yüklerken kaydedilir, 40 gün saklanır. Bahislerim'de çizgi yazmadığı için maçlar başlamadan 6q'nun bir kez açılmış olması gerekir. Kayıtlı değilse kartta elle girilebilir.
- **Adil oran:** Her maçın 1xBet/Stake Alt/Üst oranlarından kâr payı atılır, beklenen gol bulunur, toplam golün çizgiyi geçme olasılığından adil oran hesaplanır. Maçlar bağımsız, goller Poisson sayılır; sonuç tahmindir.

## Maç notları (isteğe bağlı)

Eklenti `notes.json` dosyasındaki notları kartlarda "Maç notu" olarak gösterir. Notlar otomatik gelmez: Claude'a "yorumları yaz" denince dosyaya yazılır. Dakikada bir okunur, sayfa yenilenmeden de gelir. Biçim: `{ "updatedAt": "ISO tarih", "notes": [{ "keys": ["kart yazısı"], "text": "not", "at": "ISO tarih" }] }`. Zip ile dağıtılan kopyalarda dosya güncellenmez.
