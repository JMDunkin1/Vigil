export type SacredAudioSeason =
  | "advent"
  | "christmas"
  | "lent"
  | "holy-week"
  | "easter"
  | "marian"
  | "eucharistic"
  | "pentecost"
  | "ordinary"
  | "requiem";

export type SacredAudioStyle = "gregorian-chant" | "choral" | "traditional-hymn" | "concert-band";

export interface SacredAudioTrack {
  id: string;
  title: string;
  src: string;
  seasons: readonly SacredAudioSeason[];
  styles: readonly SacredAudioStyle[];
  performer: string;
  durationSeconds: number;
  sourcePage: string;
  license: string;
  licenseUrl: string;
  attributionRequired: boolean;
  attribution: string;
}

export const sacredAudioCatalog = [
  {
    id: "rorate-caeli",
    title: "Rorate Caeli",
    src: "/audio/sacred/advent-rorate-caeli.ogg",
    seasons: ["advent"],
    styles: ["gregorian-chant"],
    performer: "Inritter",
    durationSeconds: 142.06,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Rorate_Caeli_~_Gregorian_Chant.ogg",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attributionRequired: true,
    attribution: '"Rorate Caeli ~ Gregorian Chant" by Inritter, CC BY-SA 4.0, via Wikimedia Commons.'
  },
  {
    id: "o-come-emmanuel",
    title: "O Come, O Come, Emmanuel",
    src: "/audio/sacred/advent-o-come-emmanuel-army-band.ogg",
    seasons: ["advent", "christmas"],
    styles: ["traditional-hymn", "concert-band"],
    performer: "United States Army Band",
    durationSeconds: 331.23,
    sourcePage: "https://commons.wikimedia.org/wiki/File:O_Come,_O_Come_Emmanuel_-_United_States_Army_Band.opus",
    license: "Public domain in the United States (U.S. Army work)",
    licenseUrl: "https://commons.wikimedia.org/wiki/File:O_Come,_O_Come_Emmanuel_-_United_States_Army_Band.opus",
    attributionRequired: false,
    attribution: "United States Army Band; arrangement by Douglas A. Richard; via Wikimedia Commons."
  },
  {
    id: "o-come-all-ye-faithful",
    title: "I Saw Three Ships / O Come, All Ye Faithful",
    src: "/audio/sacred/christmas-o-come-all-ye-faithful-usaf.ogg",
    seasons: ["christmas"],
    styles: ["traditional-hymn", "choral", "concert-band"],
    performer: "United States Air Force Band, Singing Sergeants and Concert Band",
    durationSeconds: 192.52,
    sourcePage: "https://commons.wikimedia.org/wiki/File:I_Saw_Three_Ships_-_O_Come_All_Ye_Faithful_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3",
    license: "Public domain in the United States (U.S. Air Force work)",
    licenseUrl: "https://commons.wikimedia.org/wiki/File:I_Saw_Three_Ships_-_O_Come_All_Ye_Faithful_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3",
    attributionRequired: false,
    attribution: "United States Air Force Band and Singing Sergeants; arrangement by Robert Thurston; via Wikimedia Commons."
  },
  {
    id: "crux-fidelis",
    title: "Crux Fidelis",
    src: "/audio/sacred/holy-week-crux-fidelis.ogg",
    seasons: ["lent", "holy-week"],
    styles: ["gregorian-chant"],
    performer: "Adabo60ge",
    durationSeconds: 51.55,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Crux_fidelis_(Graduale_2011).ogg",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Crux fidelis (Graduale 2011)" by Adabo60ge, CC BY-SA 3.0, via Wikimedia Commons.'
  },
  {
    id: "pange-lingua",
    title: "Pange Lingua Gloriosi / Tantum Ergo",
    src: "/audio/sacred/eucharistic-pange-lingua.ogg",
    seasons: ["holy-week", "eucharistic"],
    styles: ["gregorian-chant"],
    performer: "Gareth Hughes",
    durationSeconds: 205.16,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Pange_Lingua_Latin_in_Latin.ogg",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Pange Lingua Latin in Latin" sung by Gareth Hughes, CC BY-SA 3.0, via Wikimedia Commons.'
  },
  {
    id: "victimae-paschali-laudes",
    title: "Victimae Paschali Laudes",
    src: "/audio/sacred/easter-victimae-paschali-laudes.ogg",
    seasons: ["easter"],
    styles: ["gregorian-chant"],
    performer: "Makemi",
    durationSeconds: 108.85,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Victimae_Paschali_Laudes.ogg",
    license: "CC BY-SA 3.0 performance; public-domain composition",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Victimae Paschali Laudes" performed by Makemi, CC BY-SA 3.0, via Wikimedia Commons; composition traditionally attributed to Wipo of Burgundy.'
  },
  {
    id: "regina-caeli",
    title: "Regina Caeli",
    src: "/audio/sacred/easter-marian-regina-caeli.ogg",
    seasons: ["easter", "marian"],
    styles: ["gregorian-chant"],
    performer: "Ferdinando Traversa",
    durationSeconds: 36.33,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Regina_Caeli.wav",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attributionRequired: true,
    attribution: '"Regina Caeli" by Ferdinando Traversa, CC BY-SA 4.0, via Wikimedia Commons; Ogg Vorbis transcode of the source WAV.'
  },
  {
    id: "ave-maria-gregorian",
    title: "Ave Maria",
    src: "/audio/sacred/marian-ave-maria-gregorian.ogg",
    seasons: ["marian"],
    styles: ["gregorian-chant", "choral"],
    performer: "Schola Gregoriana of the Pallottine Seminary in Oltarzew, conducted by Father Dariusz Smolarek",
    durationSeconds: 70.63,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Schola_Gregoriana-Ave_Maria.ogg",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Ave Maria" performed by Schola Gregoriana of the Pallottine Seminary in Oltarzew under Father Dariusz Smolarek, CC BY-SA 3.0, via Wikimedia Commons.'
  },
  {
    id: "salve-regina",
    title: "Salve Regina",
    src: "/audio/sacred/marian-salve-regina-passy.ogg",
    seasons: ["marian"],
    styles: ["gregorian-chant", "choral"],
    performer: "Les Petits Chanteurs de Passy",
    durationSeconds: 190.09,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Petits_Chanteurs_de_Passy_-_Salve_Regina_de_Hermann_Contract.ogg",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Salve Regina" by Hermann of Reichenau, performed by Les Petits Chanteurs de Passy, CC BY-SA 3.0, via Wikimedia Commons.'
  },
  {
    id: "veni-creator-spiritus",
    title: "Veni Creator Spiritus",
    src: "/audio/sacred/pentecost-veni-creator-spiritus.ogg",
    seasons: ["pentecost"],
    styles: ["gregorian-chant"],
    performer: "Membeth",
    durationSeconds: 30.29,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Veni.creator.spiritus.ogg",
    license: "Public domain dedication by the recording's copyright holder",
    licenseUrl: "https://commons.wikimedia.org/wiki/File:Veni.creator.spiritus.ogg",
    attributionRequired: false,
    attribution: "Veni Creator Spiritus, performed by Membeth, via Wikimedia Commons."
  },
  {
    id: "kyrie-xi-orbis-factor",
    title: "Kyrie XI (Orbis Factor)",
    src: "/audio/sacred/ordinary-kyrie-xi-orbis-factor.ogg",
    seasons: ["ordinary"],
    styles: ["gregorian-chant"],
    performer: "Paterm",
    durationSeconds: 34.77,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Kyrie_XI.ogg",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    attributionRequired: true,
    attribution: '"Kyrie XI (Orbis Factor)" sung by Paterm, CC BY-SA 3.0, via Wikimedia Commons.'
  },
  {
    id: "dies-irae",
    title: "Dies Irae",
    src: "/audio/sacred/requiem-dies-irae.ogg",
    seasons: ["requiem"],
    styles: ["gregorian-chant"],
    performer: "Membeth",
    durationSeconds: 434.0,
    sourcePage: "https://commons.wikimedia.org/wiki/File:Dies.irae.ogg",
    license: "Public domain dedication by the recording's copyright holder",
    licenseUrl: "https://commons.wikimedia.org/wiki/File:Dies.irae.ogg",
    attributionRequired: false,
    attribution: "Dies Irae, performed by Membeth, via Wikimedia Commons."
  }
] as const satisfies readonly SacredAudioTrack[];

export type SacredAudioTrackId = (typeof sacredAudioCatalog)[number]["id"];
