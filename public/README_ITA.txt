World of Warcraft Maps and World 3D Explorer v11.3

1. Estrai tutto l'archivio in una cartella.
2. Fai doppio clic su START_WOW_ARCHAEOLOGY.bat.
3. Microsoft Edge si aprira su http://localhost:4173/.
4. Scegli World of Warcraft, The Burning Crusade oppure Wrath of the Lich King.

Il programma mostra esclusivamente le mappe delle tre versioni di World of Warcraft.

Il launcher usa un profilo Edge dedicato e salva tutti i relativi dati in:

WoW_Archaeology_BrowserData

La cartella viene creata accanto a start.ps1, quindi sullo stesso disco in cui hai
estratto il programma. Cache Storage, cache HTTP e profilo non finiscono nel normale
profilo Edge su C:. Ai successivi avvii, le porzioni gia visitate saranno lette dal
disco anziche essere scaricate nuovamente.

Anche le opzioni del pannello World Explorer Settings vengono salvate automaticamente nello
stesso profilo e ripristinate quando il programma viene riaperto. Il salvataggio
avviene dopo ogni modifica, quindi non dipende da una chiusura pulita del browser.
Vengono conservati anche Dynamic Time e l'orario manuale del pannello Time of Day.

Non eliminare WoW_Archaeology_BrowserData quando aggiorni il viewer. Puoi sovrascrivere
i file del programma con una nuova versione lasciando intatta quella cartella.

Nel pannello "World Explorer Settings" trovi:
- Atmospheric fog: attiva o disattiva la nebbia;
- Particles: abilita gli effetti particellari, disattivati per default;
- Render scale: risoluzione interna del mondo, dal 33% al 100%. L'interfaccia e
  l'immagine finale restano alla risoluzione del monitor;
- Upscaler: sceglie come ricostruire l'immagine quando Render scale e sotto il 100%:
  Bilinear e il filtro piu economico, Sharp aggiunge nitidezza, Edge-adaptive cerca
  di conservare meglio profili e dettagli del terreno;
- View distance: distanza massima visibile;
- Resident radius: numero di tile ADT mantenute attorno alla camera;
- Terrain detail radius: entro questa distanza il terreno usa la mesh completa;
- Ultra terrain LOD (distant): oltre Terrain detail radius usa la mesh Ultra,
  circa 32 volte piu leggera dell'originale, invece della mesh Low 8 volte piu leggera;
- Extreme terrain LOD (overrides Ultra): riduce ogni chunk lontano a soli 2 triangoli,
  circa 128 volte meno dell'originale. Se un chunk contiene buchi o ingressi di grotte,
  usa automaticamente Ultra per non chiuderli;
- Continental terrain LOD (one draw per ADT): oltre Continental radius accorpa tutti
  i chunk di una tile ADT in una sola operazione di rendering. Usa la geometria Extreme
  e la texture di base dominante dell'ADT, sacrificando le variazioni locali lontane;
- Continental radius: distanza dalla camera oltre la quale entra in funzione il
  Continental LOD. Entro questa soglia continuano a valere High, Low, Ultra o Extreme;
- Reduce distant texture detail: forza mipmap meno definite soltanto sul terreno lontano;
- Distant texture reduction: sceglie quanti livelli mip saltare (1-5);
- Object detail radius: entro questa distanza viene aggiunto il LOD 0 degli oggetti;
- Object radius: soltanto entro questa distanza vengono caricati M2 e WMO.
- Terrain queue: tile il cui terreno deve ancora essere preparato.
- Object queue: tile vicine in attesa del caricamento progressivo LOD 1 / LOD 0.
- Terrain HD/LD/U/X/C: numero di tile che usano terreno completo / Low / Ultra /
  Extreme / Continental.
- Far textures: "full" usa il dettaglio normale; "mip N+" indica la riduzione attiva.
- FPS, tempo in millisecondi e Render indicano prestazioni e risoluzione interna.
  Se abbassando Render scale gli FPS cambiano poco, il limite principale e la CPU
  o il numero di draw call, non il carico pixel della GPU;
- Riga azzurra Cache hit/miss: al secondo avvio gli hit devono aumentare rapidamente;
  Network indica invece quante risorse sono state richieste online nella sessione.

ATTENZIONE: aumentando Resident radius il viewer mantiene in memoria molte tile.
Un raggio 4 equivale al massimo a 81 tile; 8 a 289 tile; 12 a 625 tile. Procedi per gradi.

Il caricamento e diviso in fasi: prima appare il terreno; successivamente il viewer
carica il LOD 1 degli oggetti entro Object radius e infine il LOD 0 soltanto entro
Object detail radius. Le tile lontane non scaricano piu preventivamente M2 e WMO.

Oltre Terrain detail radius, il terreno passa automaticamente a una mesh semplificata
con circa 8 volte meno triangoli. Texture, confini delle tile e buchi del terreno
restano preservati; tornando vicino, la mesh completa viene riutilizzata subito e
non richiede un nuovo download.

Attivando Ultra terrain LOD, il terreno lontano usa circa 32 volte meno triangoli
della mesh originale. E la modalita pensata per tenere contemporaneamente visibile
un panorama molto largo; le montagne lontane saranno inevitabilmente piu spigolose.

Extreme terrain LOD e volutamente devastante: appiattisce quasi tutta la morfologia
interna di ciascun chunk e conserva soprattutto la forma generale del paesaggio. Ha
la precedenza su Ultra quando entrambe le caselle sono attive. I chunk con buchi
passano automaticamente a Ultra per preservare aperture e ingressi.

Continental LOD affronta un limite diverso: Extreme riduce i triangoli ma conserva
fino a 256 draw call e cambi di materiale per ADT. Continental sottopone l'intero
buffer semplificato con una sola draw call. Per renderlo possibile usa soltanto la
texture di base piu frequente dell'ADT, ripetuta sui chunk, e ignora layer locali,
alpha map e ombre del terreno lontano. Rilievo, normali, illuminazione dei vertici e
fallback geometrico attorno ai buchi restano attivi. Il passaggio e intenzionalmente
visibile: usare una soglia di 3-5 km riduce la sua evidenza.

La riduzione delle texture sfrutta le mipmap gia contenute nei file BLP: non crea
nuovi download. Riduce il dettaglio e il costo di campionamento GPU sul terreno
lontano, ma non libera tutta la memoria delle texture originali, che resta necessaria
alle tile vicine. Un valore 3 e un buon punto di partenza; 4-5 e molto aggressivo.

Preset suggerito per il massimo panorama: Terrain detail radius 0 km, Extreme terrain
LOD attivo, Reduce distant texture detail attivo a 4 o 5 livelli, Object radius al
minimo, Continental terrain LOD attivo da 3-4 km, Render scale 50-67%, Edge-adaptive
e Resident radius aumentato per gradi.

Render scale riduce il numero di pixel disegnati: al 50% per asse il mondo usa circa
un quarto dei pixel della risoluzione nativa. Non accelera pero download, parsing delle
tile o preparazione delle draw call. Bilinear serve anche come test prestazionale puro;
Sharp ed Edge-adaptive costano leggermente di piu ma producono un'immagine piu definita.
Il filtro Edge-adaptive e una ricostruzione spaziale ispirata agli upscaler moderni e
funziona senza motion vector o frame precedenti su WebGL 2 e WebGPU; non e il plugin
nativo NVIDIA DLSS ne l'SDK temporale AMD FSR 2.

Per cancellare deliberatamente tutti i dati scaricati, chiudi Edge e cancella la
cartella WoW_Archaeology_BrowserData. Non farlo durante l'esecuzione del viewer.

Per chiudere il server, torna alla finestra PowerShell e premi Ctrl+C.
