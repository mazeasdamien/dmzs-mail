/**
 * Tests for the parts that rot silently: header decoding, addresses,
 * message building, HTML defusing, token sealing.
 * Run with: node test.mjs
 */
import {
  decodeWords,
  qpDecode,
  parseAddress,
  parseAddressList,
  normalizeSubject,
  encodeHeader,
  buildRfc822,
  sanitizeHtml,
  textToHtml,
  blockMatches,
  isBlockPattern,
  b64encode,
  b64decode,
  htmlToText,
} from "./src/mime.js";
import {
  parseSexp,
  flattenStructure,
  parseHeaders,
  parseParams,
  splitParts,
  decodePart,
  parseMessage,
} from "./src/rfc822.js";
import { seal, open } from "./src/crypto.js";
import { BODY_VERSION, bodyFromParts, unsubFromHeaders } from "./src/body.js";
import { MailAuthError, isAuthFailure } from "./src/errors.js";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — reçu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);

console.log("\n── en-têtes RFC 2047 ───────────────────────");
eq(decodeWords("=?UTF-8?B?w4l0w6k=?="), "Été", "B-encoding utf-8");
eq(decodeWords("=?utf-8?Q?caf=C3=A9_cr=C3=A8me?="), "café crème", "Q-encoding, _ = espace");
eq(decodeWords("=?ISO-8859-1?Q?d=E9j=E0?="), "déjà", "latin-1");
eq(decodeWords("=?UTF-8?B?QQ==?= =?UTF-8?B?Qg==?="), "AB", "l'espace entre deux mots encodés disparaît");
eq(decodeWords("Re: =?utf-8?B?ZMOpcGxvaWVtZW50?="), "Re: déploiement", "mélange brut + encodé");
eq(decodeWords("rien à décoder"), "rien à décoder", "texte simple inchangé");

console.log("\n── quoted-printable ────────────────────────");
eq(qpDecode("caf=C3=A9"), "café", "octets encodés");
eq(qpDecode("ligne =\r\ncoup=C3=A9e"), "ligne coupée", "retour souple absorbé");

console.log("\n── adresses ────────────────────────────────");
eq(parseAddress('"Jean Dupont" <jean@x.fr>'), { name: "Jean Dupont", email: "jean@x.fr" }, "guillemets + chevrons");
eq(parseAddress("jean@x.fr"), { name: "", email: "jean@x.fr" }, "adresse nue");
eq(parseAddress("Jean <JEAN@X.FR>"), { name: "Jean", email: "jean@x.fr" }, "casse normalisée");
eq(parseAddress("=?utf-8?B?SsOpcsO0bWU=?= <j@x.fr>").name, "Jérôme", "nom encodé décodé");
eq(parseAddressList('"Dupont, Jean" <j@x.fr>, b@y.fr').length, 2, "virgule entre guillemets ignorée");
eq(parseAddressList("a@x.fr, b@y.fr, pas-une-adresse").length, 2, "les déchets sont filtrés");
// Outlook écrit un destinataire non résolu 'comme@ceci.fr'. Gardées, ces
// apostrophes arrivent jusqu'au RCPT TO et Apple refuse tout le message.
eq(parseAddress("'jean@x.fr'"), { name: "", email: "jean@x.fr" }, "apostrophes d'Outlook retirées");
eq(parseAddress("<'jean@x.fr'>"), { name: "", email: "jean@x.fr" }, "apostrophes dans les chevrons");
eq(parseAddress("o'brien@x.fr").email, "o'brien@x.fr", "apostrophe interne conservée");
eq(
  parseAddressList("'a@x.fr', b@y.fr").map((a) => a.email),
  ["a@x.fr", "b@y.fr"],
  "liste : citée puis nue"
);

console.log("\n── sujets et fils ──────────────────────────");
eq(normalizeSubject("Re: Re: FWD: Hello"), "hello", "préfixes empilés retirés");
eq(normalizeSubject("RE : bonjour"), "bonjour", "variante française RE :");
eq(normalizeSubject("Hello"), "hello", "sans préfixe");

console.log("\n── message sortant ─────────────────────────");
const raw = buildRfc822({
  from: "damien@x.fr",
  to: "ami@y.fr",
  subject: "Été à Brest",
  text: "Salut — ça marche.",
  inReplyTo: "<abc@mx>",
});
ok(raw.includes("From: damien@x.fr"), "From présent");
ok(raw.includes("Subject: =?utf-8?B?"), "sujet non-ASCII encodé");
ok(raw.includes("In-Reply-To: <abc@mx>"), "In-Reply-To présent");
ok(raw.includes("References: <abc@mx>"), "References présent");
ok(/\r\n\r\n[A-Za-z0-9+/=\r\n]+\r\n$/.test(raw), "corps en base64");
eq(encodeHeader("plain ascii"), "plain ascii", "ASCII pur laissé tel quel");
{
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  const round = new TextDecoder().decode(b64decode(b64encode(new TextEncoder().encode("Salut — ça marche."))));
  eq(round, "Salut — ça marche.", "aller-retour base64 fidèle");
  ok(body.length > 0, "corps non vide");
}

console.log("\n── copies cachées ──────────────────────────");
{
  // buildRfc822 n'écrit JAMAIS de Bcc. Un tel en-tête partirait tel quel chez
  // tout le monde, ce qui est l'inverse de « caché » : les destinataires
  // invisibles ne vivent que dans l'enveloppe SMTP, jamais dans le message.
  ok(!raw.includes("Bcc:"), "pas de Bcc quand aucun n'est passé");

  const avec = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", cc: "c@y.fr", subject: "Salut", text: "corps",
  });
  ok(avec.includes("Cc: c@y.fr"), "Cc présent");
  ok(!/^Bcc:/im.test(avec), "aucun en-tête Bcc");

  // Et même en le passant : le paramètre n'existe plus, donc rien ne doit
  // ressortir. C'est ce test qui garde le piège refermé pour la suite.
  const force = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", bcc: "secret@y.fr", subject: "Salut", text: "corps",
  });
  ok(!force.includes("secret@y.fr"), "un bcc passé par erreur ne fuit pas");
  ok(!/^Bcc:/im.test(force), "un bcc passé par erreur n'écrit pas d'en-tête");

  // Le brouillon est le seul message qui n'est envoye a personne : son en-tete
  // Bcc est ce qui fait survivre le champ a la fermeture du compositeur. Il
  // porte un autre nom pour qu'on ne puisse pas l'obtenir par megarde.
  const brouillon = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", draftBcc: "cache@y.fr", subject: "Salut", text: "corps",
  });
  ok(/^Bcc: cache@y\.fr$/im.test(brouillon), "un brouillon garde ses destinataires caches");
  const envoye = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", bcc: "cache@y.fr", subject: "Salut", text: "corps",
  });
  ok(!envoye.includes("cache@y.fr"), "le meme champ sous le nom bcc reste ignore");

  // Idem en multipart, où l'en-tête se glisserait dans une autre section.
  const rich = buildRfc822({ from: "d@x.fr", to: "a@y.fr", html: "<p>x</p>", bcc: "secret@z.fr" });
  ok(!/^Bcc:/im.test(rich), "pas de Bcc fantôme en multipart");
  ok(!rich.includes("secret@z.fr"), "l'adresse cachée n'apparaît nulle part");
}

console.log("\n── message HTML sortant ────────────────────");
{
  const rich = buildRfc822({
    from: "d@x.fr",
    to: "a@y.fr",
    subject: "Salut",
    text: "version texte",
    html: "<p>version <b>riche</b></p>",
  });
  const bnd = /boundary="([^"]+)"/.exec(rich)[1];
  ok(rich.includes("Content-Type: multipart/alternative"), "multipart/alternative");
  const chunks = rich.split("--" + bnd);
  ok(chunks[1].includes("text/plain"), "part 1 = texte brut");
  ok(chunks[2].includes("text/html"), "part 2 = html (la plus riche en dernier)");
  ok(rich.trimEnd().endsWith("--" + bnd + "--"), "boundary de fermeture présent");

  // Le vrai test : ce qu'on écrit doit se relire avec notre propre analyseur.
  const back = parseMessage(rich);
  eq(back.text, "version texte", "aller-retour MIME : texte");
  eq(back.html, "<p>version <b>riche</b></p>", "aller-retour MIME : html");

  // Sans part texte fournie, elle est dérivée du HTML plutôt qu'omise.
  const derived = parseMessage(buildRfc822({ from: "d@x.fr", to: "a@y.fr", html: "<p>un</p><p>deux</p>" }));
  eq(derived.text, "un\ndeux", "part texte dérivée du HTML");

  eq(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b", "listes en texte");
  eq(htmlToText("a &amp; b &lt;c&gt;"), "a & b <c>", "entités décodées");
}

console.log("\n── pièces jointes ──────────────────────────");
{
  const pdf = b64encode(new TextEncoder().encode("%PDF-1.4 faux contenu"));
  const raw = buildRfc822({
    from: "d@x.fr",
    to: "a@y.fr",
    subject: "avec pièce jointe",
    html: "<p>voir ci-joint</p>",
    attachments: [{ filename: "état des lieux.pdf", type: "application/pdf", data: pdf }],
  });

  ok(raw.includes("Content-Type: multipart/mixed"), "enveloppe multipart/mixed");
  ok(raw.includes("multipart/alternative"), "le corps texte+html reste imbriqué dedans");
  ok(/Content-Disposition: attachment/.test(raw), "part marquée comme pièce jointe");
  ok(raw.includes("=?utf-8?B?"), "nom de fichier non-ASCII encodé");
  ok(raw.trimEnd().endsWith("--"), "boundary de fermeture");

  // Ce qu'on écrit doit se relire : structure, corps et fichier.
  const back = parseMessage(raw);
  eq(back.html, "<p>voir ci-joint</p>", "aller-retour : html intact malgré l'imbrication");
  eq(back.text, "voir ci-joint", "aller-retour : texte dérivé présent");
  eq(back.attachments.length, 1, "une pièce jointe retrouvée");
  eq(back.attachments[0].filename, "état des lieux.pdf", "nom de fichier décodé");
  eq(back.attachments[0].type, "application/pdf", "type conservé");
  eq(back.attachments[0].part, "2", "chemin de part IMAP (corps=1, fichier=2)");
  eq(decodePart(back.attachments[0].body, "base64", "utf-8"), "%PDF-1.4 faux contenu", "contenu exact");

  // Sans pièce jointe, pas d'enveloppe mixed inutile.
  ok(!buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" }).includes("multipart/mixed"),
     "pas de multipart/mixed quand il n'y a rien à joindre");
}

console.log("\n── HTML désamorcé ──────────────────────────");
{
  const { html, blocked } = sanitizeHtml(
    `<p onclick="x()">ok</p><script>evil()</script><img src="https://t.example/pixel.gif">` +
      `<a href="javascript:alert(1)">clic</a><iframe src="https://x"></iframe><img src="cid:inline1">`
  );
  ok(!/<script/i.test(html), "script supprimé");
  ok(!/onclick/i.test(html), "gestionnaire d'événement supprimé");
  ok(!/<iframe/i.test(html), "iframe supprimée");
  ok(!/javascript:/i.test(html), "href javascript: neutralisé");
  ok(/data-blocked-src="https:\/\/t\.example\/pixel\.gif"/.test(html), "image distante bloquée mais réversible");
  ok(/src="cid:inline1"/.test(html), "les images cid: ne comptent pas comme distantes");
  eq(blocked, 1, "une seule ressource distante comptée");
  ok(html.includes(">ok</p>"), "le contenu sain survit");
}
{
  const t = textToHtml("ligne 1\nvoir https://exemple.fr/x?a=1 <fin>");
  ok(t.includes("&lt;fin&gt;"), "texte échappé");
  ok(t.includes('<a href="https://exemple.fr/x?a=1"'), "lien cliquable");
}

console.log("\n── pixels espions, formes non guillemetées ──");
{
  // Le bloc au-dessus ne testait que la valeur entre guillemets doubles.
  // `src=https://…` sans guillemets est du HTML valide : le pixel partait à
  // l'ouverture et `blocked` restait à 0, donc le bouton Images n'apparaissait
  // même pas pour le signaler. Une régression ici se paie en traçage.
  const fuite = /(?<!data-blocked-)(src|srcset|background|poster)\s*=/i;
  for (const [html, label] of [
    ["<img src=https://t.example/p.gif>", "src nu"],
    ["<img src='https://t.example/p.gif'>", "apostrophes"],
    ["<img src=//t.example/p.gif>", "protocole-relatif nu"],
    ['<img src=" https://t.example/p.gif">', "espace avant l'URL"],
    ["<img/src=https://t.example/p.gif>", "slash comme séparateur"],
    ["<table background=https://t.example/p.png>", "background nu"],
    ['<img srcset="a.png 1x, https://t.example/p.png 2x">', "srcset, 2e candidat distant"],
  ]) {
    const out = sanitizeHtml(html);
    ok(out.blocked === 1 && !fuite.test(out.html), `${label} — obtenu ${JSON.stringify(out)}`);
  }

  // Et l'inverse : ce qui ne sort pas sur le réseau doit rester intact.
  for (const [html, label] of [
    ['<img src="cid:inline1">', "cid: non compté"],
    ['<img src="/logo.png">', "chemin relatif non compté"],
    ['<img src="data:image/gif;base64,R0lGOD//">', "data: non compté"],
  ]) {
    ok(sanitizeHtml(html).blocked === 0, label);
  }

  ok(
    !/url\s*\(/i.test(sanitizeHtml("<div style=background:url(https://t.example/p.png)>x</div>").html),
    "style nu contenant url() retiré"
  );
}

console.log("\n-- expediteurs bloques ---------------------");
{
  // Une regle de domaine doit couvrir les sous-domaines : c'est de la que part
  // le courrier d'une entreprise, et changer de sous-domaine suffirait sinon a
  // passer au travers.
  ok(blockMatches("sellersupport@shop.tiktok.com", "tiktok.com"), "le domaine prend ses sous-domaines");
  ok(blockMatches("a@tiktok.com", "tiktok.com"), "le domaine prend le domaine nu");
  ok(blockMatches("a@TikTok.COM", "tiktok.com"), "insensible a la casse");
  ok(blockMatches("a@tiktok.com", "@tiktok.com"), "une regle ecrite avec @ vaut le domaine");

  // Le point est ce qui empeche la regle de deborder. Ces trois-la detruiraient
  // du courrier legitime, et il n'y a pas de retour en arriere.
  ok(!blockMatches("a@nottiktok.com", "tiktok.com"), "un suffixe colle ne correspond pas");
  ok(!blockMatches("a@tiktok.com.evil.net", "tiktok.com"), "un domaine parent usurpe ne correspond pas");
  ok(!blockMatches("tiktok.com@gmail.com", "tiktok.com"), "le nom local ne compte pas");

  // Une regle d'adresse ne vaut que pour elle-meme.
  ok(blockMatches("a@x.fr", "a@x.fr"), "l'adresse exacte correspond");
  ok(!blockMatches("b@x.fr", "a@x.fr"), "une autre adresse du meme domaine ne correspond pas");
  ok(!blockMatches("", "x.fr") && !blockMatches("a@x.fr", ""), "rien ne correspond a rien");

  ok(isBlockPattern("tiktok.com") && isBlockPattern("a@x.fr"), "domaine et adresse sont des motifs");
  ok(!isBlockPattern("com"), "un TLD nu n'est pas un motif");
  ok(!isBlockPattern("tiktok com") && !isBlockPattern(""), "ni un espace ni le vide");
}

console.log("\n-- feuilles de style conservees ------------");
{
  // Le motif qui rendait des messages entierement blancs : contenu masque en
  // ligne, revele par une regle dans <style>. En supprimant le <style>, le
  // texte restait dans la source, invisible pour toujours.
  const piege = `<html><head><style>.main{display:block !important}</style></head>
<body><div class="main" style="display:none"><p>le vrai message</p></div></body></html>`;
  const out = sanitizeHtml(piege).html;
  ok(/<style>/i.test(out), "le bloc <style> survit");
  ok(out.includes(".main{display:block !important}"), "la regle qui revele le contenu survit");
  ok(out.includes("le vrai message"), "le texte est toujours la");

  // Ce que le CSS ne doit plus pouvoir faire : aller chercher quelque chose.
  const traceur = sanitizeHtml(
    `<style>@import url("https://t.example/x.css");
     body{background:url(https://t.example/p.gif)}
     .a{background:url("//t.example/q.gif")}
     .b{background:url(data:image/gif;base64,AA)}</style>`
  );
  ok(!/@import/i.test(traceur.html), "@import retire");
  ok(!/t\.example/.test(traceur.html), "aucun chargement distant ne subsiste");
  ok(traceur.html.includes("url(data:image/gif;base64,AA)"), "les url() data: restent");
  eq(traceur.blocked, 3, "les trois chargements distants sont comptes");

  // <script> continue de disparaitre entierement, contenu compris.
  const js = sanitizeHtml(`<style>.x{color:red}</style><script>evil()</script><p>ok</p>`).html;
  ok(!/evil\(\)/.test(js), "le contenu de <script> ne survit pas");
  ok(js.includes(".x{color:red}"), "celui de <style> si");

  // Un <style> jamais referme : tout ce qui suit est du CSS pour un
  // navigateur, donc le supprimer est ce qui s'affiche vraiment.
  const casse = sanitizeHtml(`<p>avant</p><style>.y{color:red} <p>apres</p>`).html;
  ok(casse.includes("avant"), "ce qui precede un <style> non ferme reste");
  ok(!casse.includes("apres"), "ce qui suit est traite comme du CSS, donc retire");
  ok(!/\.y\{color:red\}/.test(casse), "et les regles orphelines ne fuient pas en texte");
}

console.log("\n── analyse MIME (rfc822) ───────────────────");
{
  // En-têtes repliés : un Content-Type long arrive coupé sur deux lignes, et
  // sans recollage le boundary est perdu — le message se réduit à une part.
  const h = parseHeaders("Subject: a\r\nX-Long: one\r\n\ttwo\r\nFrom: b\r\nSubject: ignoré");
  eq(h["x-long"], "one two", "ligne de continuation recollée");
  eq(h["subject"], "a", "premier en-tête gagne");
  eq(h["from"], "b", "nom en minuscules");

  // Un boundary entre guillemets a le droit de contenir un point-virgule.
  const ct = parseParams('multipart/mixed; boundary="a;b"; charset=utf-8');
  eq(ct.value, "multipart/mixed", "type extrait");
  eq(ct.params.boundary, "a;b", "point-virgule protégé par les guillemets");
  eq(ct.params.charset, "utf-8", "paramètre suivant intact");

  eq(splitParts("préambule\r\n--B\r\nun\r\n--B\r\ndeux\r\n--B--\r\népilogue", "B"),
     ["un", "deux"], "préambule et épilogue écartés");

  eq(decodePart("Bonjour =C3=A0 tous", "quoted-printable", "utf-8"), "Bonjour à tous", "QP + utf-8");
  eq(decodePart(b64encode(new TextEncoder().encode("Été")), "base64", "utf-8"), "Été", "base64 + utf-8");
  eq(decodePart("d\xE9j\xE0", "7bit", "iso-8859-1"), "déjà", "latin-1 non encodé");
}
{
  // Un vrai message : mixed > alternative, encodages différents par part,
  // en-tête replié, et une pièce jointe.
  const htmlB64 = b64encode(new TextEncoder().encode("<p>Bonjour</p>"));
  const raw =
    'From: =?utf-8?B?SsOpcsO0bWU=?= <j@x.fr>\r\n' +
    "Subject: Rapport\r\n" +
    'Content-Type: multipart/mixed;\r\n boundary="OUTER"\r\n' +
    "MIME-Version: 1.0\r\n" +
    "\r\n" +
    "ceci est un préambule\r\n" +
    "--OUTER\r\n" +
    'Content-Type: multipart/alternative; boundary="INNER"\r\n' +
    "\r\n" +
    "--INNER\r\n" +
    'Content-Type: text/plain; charset="utf-8"\r\n' +
    "Content-Transfer-Encoding: quoted-printable\r\n" +
    "\r\n" +
    "Bonjour =C3=A0 tous\r\n" +
    "--INNER\r\n" +
    'Content-Type: text/html; charset="utf-8"\r\n' +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    htmlB64 + "\r\n" +
    "--INNER--\r\n" +
    "--OUTER\r\n" +
    'Content-Type: application/pdf; name="rapport.pdf"\r\n' +
    'Content-Disposition: attachment; filename="=?utf-8?B?w6l0w6kucGRm?="\r\n' +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    "JVBERi0xLjQK\r\n" +
    "--OUTER--\r\n";

  const m = parseMessage(raw);
  eq(m.text, "Bonjour à tous", "part texte décodée (QP)");
  eq(m.html, "<p>Bonjour</p>", "part HTML décodée (base64)");
  eq(m.attachments.length, 1, "une pièce jointe");
  eq(m.attachments[0].filename, "été.pdf", "nom de fichier RFC 2047 décodé");
  eq(m.attachments[0].type, "application/pdf", "type de la pièce jointe");
  ok(!m.text.includes("préambule"), "le préambule ne fuit pas dans le corps");
  eq(parseAddress(m.headers["from"]).name, "Jérôme", "en-tête From exploitable");

  // Message trivial sans MIME du tout.
  const plain = parseMessage("Subject: x\r\n\r\nligne unique");
  eq(plain.text, "ligne unique", "message non-MIME lu comme texte");
  eq(plain.attachments.length, 0, "aucune pièce jointe inventée");
}

console.log("\n── scellement des jetons ───────────────────");
{
  const KEY = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  const secret = { refresh_token: "1//abcd", access_token: "ya29.x", exp: 1234 };
  const blob = await seal(KEY, secret);
  eq(await open(KEY, blob), secret, "aller-retour fidèle");
  ok((await open(KEY, blob.slice(0, -4) + "AAAA")) === null, "blob altéré → null");
  const OTHER = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  ok((await open(OTHER, blob)) === null, "mauvaise clé → null");
  ok(blob !== (await seal(KEY, secret)), "IV frais à chaque scellement");
}

console.log("");
console.log("-- BODYSTRUCTURE --------------------------");
{
  // Ce qu'Apple renvoie pour texte+html plus une piece jointe de 26 Mo. Lire
  // cette structure evite de telecharger 26 Mo pour afficher 2 Ko de HTML.
  const bs =
    '((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 401 9)' +
    '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 2118 41) "ALTERNATIVE")' +
    '("APPLICATION" "PDF" ("NAME" "rapport.pdf") NIL NIL "BASE64" 27891234 NIL ' +
    '("attachment" ("FILENAME" "rapport.pdf")) NIL) "MIXED")';

  const parts = flattenStructure(parseSexp(bs));
  eq(parts.length, 3, "trois parts feuilles");
  eq(parts[0].part, "1.1", "chemin de la part texte");
  eq(parts[1].part, "1.2", "chemin de la part html");
  eq(parts[1].type, "text/html", "type html");
  eq(parts[1].encoding, "quoted-printable", "encodage lu");
  eq(parts[1].size, 2118, "taille de la part html : 2 Ko, pas 26 Mo");
  eq(parts[2].part, "2", "chemin de la piece jointe");
  eq(parts[2].filename, "rapport.pdf", "nom de fichier");
  eq(parts[2].disposition, "attachment", "disposition");

  const flat = flattenStructure(parseSexp('("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 12 1)'));
  eq(flat.length, 1, "message non-multipart : une seule part");
  eq(flat[0].part, "1", "chemin 1 par defaut");
  eq(parseSexp('("a" NIL 3)'), ["a", null, "3"], "NIL devient null");
}

console.log("\n-- identite du message sortant -------------");
{
  // Sans Message-ID, un message envoye est introuvable par la suite : c'est par
  // lui qu'on retrouve le message en IMAP pour l'etoiler, le deplacer ou le
  // lire. Pire, l'id local en derive, donc deux envois sans Message-ID se
  // hachent pareil et s'ecrasent l'un l'autre dans Envoyes.
  const raw = buildRfc822({ from: "d@x.fr", to: "a@y.fr", subject: "s", text: "corps" });
  ok(/^Message-ID: <[^<>@]+@x\.fr>$/m.test(raw), "Message-ID present, sur le domaine de l'expediteur");
  ok(/^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m.test(raw), "Date au format RFC 5322");

  const a = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" });
  const b = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" });
  const idOf = (s) => /^Message-ID: (.+)$/m.exec(s)[1];
  ok(idOf(a) !== idOf(b), "deux messages identiques ont des Message-ID distincts");

  // Impose de l'exterieur : c'est ainsi que l'appelant sait sous quel id
  // classer sa propre copie dans Envoyes.
  const fixe = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x", messageId: "<abc@x.fr>" });
  ok(fixe.includes("Message-ID: <abc@x.fr>"), "Message-ID fourni respecte");

  // Aller-retour : le message qu'on APPEND dans Envoyes est relu par
  // parseMessage pour construire la ligne affichee.
  const back = parseMessage(fixe);
  eq(back.headers["message-id"], "<abc@x.fr>", "Message-ID relu a l'identique");
  ok(!!Date.parse(back.headers.date), "Date relue et analysable");
}

console.log("\n-- message imbrique (transfert, rapport) ---");
{
  // Un transfert : le message d'origine voyage en message/rfc822. Sans
  // recursion dedans, walk() ne trouvait ni html ni texte et le lecteur
  // affichait une page blanche — le contenu etait pourtant la.
  const inner =
    "From: exp@y.fr\r\nSubject: original\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncontenu d'origine";
  const raw =
    "From: a@x.fr\r\nSubject: Fwd: original\r\n" +
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    "--B\r\nContent-Type: message/rfc822\r\n\r\n" +
    inner +
    "\r\n--B--\r\n";

  const m = parseMessage(raw);
  ok(m.text.includes("contenu d'origine"), "le corps du message transfere est lu");
  eq(m.attachments.length, 0, "il n'est pas classe comme piece jointe opaque");

  // Mais un message joint volontairement — avec un nom de fichier — reste une
  // piece jointe : c'est ce que l'expediteur a voulu dire.
  const joint =
    "From: a@x.fr\r\n" +
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    "--B\r\nContent-Type: message/rfc822; name=\"vieux.eml\"\r\n" +
    'Content-Disposition: attachment; filename="vieux.eml"\r\n\r\n' +
    inner +
    "\r\n--B--\r\n";
  eq(parseMessage(joint).attachments.length, 1, "message joint nomme : reste une piece jointe");
}

/* ── le client, éprouvé comme le reste ──────────────────────────
 *
 * public/index.html porte quatre mille lignes de script qu'aucun test n'avait
 * jamais exécutées : check-client.mjs vérifie qu'elles s'analysent, pas ce
 * qu'elles font. Les trois bugs de la semaine — les destinataires d'un reply
 * all, les apostrophes qu'Outlook met autour d'une adresse, le texte tapé qui
 * finissait dans la citation — étaient tous là.
 *
 * Les fonctions qui ne touchent pas au DOM sont découpées du script livré et
 * évaluées ici, leurs dépendances passées en paramètres. Rien à installer, et
 * c'est bien le code déployé qui est mis à l'épreuve, pas une copie qui
 * dériverait de son côté.
 */
// Fins de ligne ramenées à LF : un checkout Windows a des CRLF, et les
// découpes ci-dessous cherchent "\n}\n".
const clientScript = readFileSync(new URL("./public/index.html", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .split("<script>")[1]
  .split("</script>")[0];

/** Une déclaration, découpée du script client par son nom. */
function decl(name) {
  const at = clientScript.search(new RegExp(`^(?:async )?(?:function ${name}\\b|const ${name} = )`, "m"));
  if (at < 0) throw new Error(`introuvable dans le client : ${name}`);
  const rest = clientScript.slice(at);
  // Une fonction se ferme sur une accolade en première colonne ; une constante
  // fléchée se termine au point-virgule suivi de la ligne vide qui la sépare
  // de la suivante. Le fichier est écrit comme ça de bout en bout.
  const end = rest.startsWith("const") ? rest.indexOf(";\n\n") + 1 : rest.indexOf("\n}\n") + 2;
  if (end <= 1) throw new Error(`fin de déclaration introuvable : ${name}`);
  return rest.slice(0, end);
}

/** Ces fonctions-là, avec ce qu'elles attendent autour d'elles. */
function clientFns(names, globals = {}) {
  const keys = Object.keys(globals);
  const src = names.map(decl).join("\n");
  return new Function(...keys, `${src}\nreturn { ${names.join(", ")} };`)(...keys.map((k) => globals[k]));
}

console.log("\n-- client : adresses d'une reponse ---------");
{
  const me = "moi@x.fr";
  const { addressesIn, replyTargets } = clientFns(["addressesIn", "replyTargets"], {
    acctById: () => ({ email: me }),
  });
  const msg = (from, to, cc) => ({ account_id: "a", from_email: from, to_line: to, cc_line: cc });

  eq(addressesIn(`'${me}', b@y.fr`), [me, "b@y.fr"], "apostrophes d'Outlook retirées");
  eq(addressesIn("o'brien@y.fr"), ["o'brien@y.fr"], "apostrophe interne conservée");

  eq(
    replyTargets(msg("jean@y.fr", `'${me}'`, `'${me}', claire@z.fr`), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "reçu : l'expéditeur en To, soi-même retiré du Cc"
  );
  eq(
    replyTargets(msg(me, "jean@y.fr", "claire@z.fr"), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "envoyé : on réécrit aux mêmes, pas à soi"
  );
  eq(
    replyTargets(msg(me, "jean@y.fr", "claire@z.fr"), false),
    { to: ["jean@y.fr"], cc: [] },
    "envoyé, réponse simple : le Cc reste dehors"
  );
  eq(
    replyTargets(msg("jean@y.fr", "", `claire@z.fr, ${me}`), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "en copie seulement : l'expéditeur reste adressé"
  );
  eq(
    replyTargets(msg(me, "", "claire@z.fr"), true),
    { to: ["claire@z.fr"], cc: [] },
    "rien en To : le premier du Cc est promu"
  );
}

/* Les deux bouts d'une même phrase, dans deux fonctions qui ne se voient pas :
 * icloudAct annonce qu'il n'a trouvé le message dans aucune boîte, et purge
 * doit reconnaître cette annonce-là pour effacer quand même la ligne ici. Si
 * l'un des deux est reformulé un jour, un brouillon redevient indélébile, et
 * personne ne s'en apercevra avant d'essayer de le supprimer. */
console.log("\n-- purge : ce qui est deja perdu ----------");
{
  const worker = readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
  const thrown = (/throw new Error\("([^"]*not found[^"]*)"\)/.exec(worker) || [])[1] || "";
  const tolerated = (/if \(!\/([^/]+)\/i\.test\(String\(e\.message/.exec(worker) || [])[1] || "";
  ok(!!thrown, "icloudAct dit toujours qu'il n'a rien trouvé");
  ok(!!tolerated, "purge tolère toujours une de ces phrases");
  ok(
    !!thrown && !!tolerated && new RegExp(tolerated, "i").test(thrown),
    `purge reconnaît la phrase d'icloudAct — "${tolerated}" contre "${thrown}"`
  );
}

console.log("\n-- client : bascules Cc / Bcc ---------------");
{
  // La paire a cinq cases : bouton, champ, input, chips, libellé. Une
  // destructuration a trois trous sautait deux cases au lieu d'une, et le
  // bouton s'intitulait « + #cCcChips » — le texte de Cc et Bcc devenait
  // illisible à l'ouverture du composeur.
  const m = /const CC_TOGGLES = (\[[\s\S]*?\n\]);/.exec(clientScript);
  ok(!!m, "CC_TOGGLES présent");
  const list = m ? new Function(`return ${m[1]}`)() : [];
  eq(list.map((t) => t[4]), ["Cc", "Bcc"], "le libellé est la 5e case");
  eq(list.map((t) => t.length), [5, 5], "cinq cases, pas quatre");
  ok(
    /for \(const \[btn, wrap, , , name\] of CC_TOGGLES\) markToggle/.test(clientScript),
    "init lit le libellé au 5e rang"
  );
  ok(
    /for \(const \[btn, wrap, input, chips, name\] of CC_TOGGLES\)/.test(clientScript),
    "le gestionnaire de clic lit les cinq cases"
  );
}

console.log("\n-- client : signature de l'assistant -------");
{
  const sig = (email, label = "") =>
    clientFns(["signature"], { acctById: () => ({ email, label }), composeAcct: "a" }).signature();
  eq(sig("jean.dupont@x.fr"), "Jean", "prénom tiré de l'adresse");
  eq(sig("jean-luc.picard@x.fr"), "Jean-Luc", "prénom composé gardé entier");
  eq(sig("contact@x.fr"), "", "une boîte nommée contact ne signe rien");
  eq(sig("x@y.fr", "Jean Dupont"), "Jean Dupont", "le libellé du compte l'emporte");
}

console.log("\n── corps stockés : une seule forme ----------");
{
  // Trois endroits assemblaient ce document à la main et n'étaient pas d'accord
  // sur quels champs étaient optionnels. `tooLarge` est passé entre les deux.
  const base = bodyFromParts({ html: "<p>ok</p>", blocked: 1 });
  eq(base.v, BODY_VERSION, "le corps porte sa version de défense");
  eq(base.html, "<p>ok</p>", "html passé tel quel");
  eq(base.blocked, 1, "blocages comptés");
  eq(base.attachments, [], "pièces jointes : liste vide, jamais absente");
  eq(base.unsubscribe, "", "désabonnement : chaîne vide, jamais absent");
  eq(base.unsubscribeOneClick, false, "one-click faux par défaut");
  ok(!("tooLarge" in base) && !("empty" in base) && !("missing" in base),
     "aucun drapeau quand tout va bien");

  // Trop gros : le drapeau est la vérité, le texte de remplacement est un
  // pis-aller pour le client d'avant, et le texte du message sert de note
  // quand il y en a un — mieux qu'une phrase inventée.
  const grand = bodyFromParts({ text: "résumé lisible", tooLarge: true });
  eq(grand.tooLarge, true, "tooLarge posé");
  ok(grand.html.includes("résumé lisible"), "le texte du message sert de note");
  ok(!/[<>]/.test(grand.html.replace(/<\/?p>/g, "")), "la note est échappée");

  const sansTexte = bodyFromParts({ tooLarge: true });
  ok(sansTexte.html.length > 0, "sans texte, un message de repli tout de même");
  ok(sansTexte.html.startsWith("<p>"), "le repli est un paragraphe, pas du HTML cru");
  eq(sansTexte.tooLarge, true, "le drapeau survit au repli");

  // Ces deux-là ne sont pas des corps factices : le client parle à sa voix.
  const vide = bodyFromParts({ html: "", empty: true });
  eq(vide.empty, true, "empty posé");
  eq(vide.html, "", "empty n'injecte pas de faux message");
  const perdu = bodyFromParts({ missing: true });
  eq(perdu.missing, true, "missing posé");
  eq(perdu.html, "", "missing n'injecte pas de faux message");

  // En-têtes de liste : RFC 2369 et 8058, presque jamais exposés ailleurs.
  const unsub = unsubFromHeaders({
    "list-unsubscribe": "<https://x.fr/unsub>, <mailto:u@x.fr>",
    "list-unsubscribe-post": "List-Unsubscribe=One-Click",
  });
  eq(unsub.unsubscribe, "<https://x.fr/unsub>, <mailto:u@x.fr>", "List-Unsubscribe conservé");
  eq(unsub.unsubscribeOneClick, true, "one-click reconnu");
  eq(unsubFromHeaders({ "list-unsubscribe": "x".repeat(700) }).unsubscribe.length, 600,
     "l'en-tête est borné");
  eq(unsubFromHeaders({}).unsubscribe, "", "en-têtes absents : champs vides");
}

console.log("\n── échec d'authentification : une seule voix -");
{
  // Le drapeau `e.reauth` bricolé sur n'importe quelle Error est ce que
  // MailAuthError remplace. Les deux formes doivent rester reconnues, sinon un
  // ancien chemin se met à répondre 502 là où l'utilisateur doit se reconnecter.
  ok(isAuthFailure(new MailAuthError()), "MailAuthError est un échec d'auth");
  ok(isAuthFailure(new MailAuthError("refusé")), "le message ne change rien");
  ok(isAuthFailure({ reauth: true }), "l'ancien drapeau est toujours lu");
  ok(!isAuthFailure(new Error("pas de réseau")), "une erreur réseau n'en est pas une");
  ok(!isAuthFailure(null) && !isAuthFailure(undefined), "null n'en est pas un");
  ok(new MailAuthError().name === "MailAuthError", "le nom porte le type");
}

console.log("\n── audit 2026-10-17 : failles fermées ──────");
{
  // Un attribut collé au guillemet fermant du précédent est un second
  // attribut pour un navigateur. Le filtre exigeait un espace avant « on… ».
  const colle = sanitizeHtml(`<img src="x"onerror="alert(1)"><p title='a'onclick='b()'>t</p>`).html;
  ok(!/onerror|onclick/i.test(colle), `gestionnaire collé au guillemet supprimé — ${colle}`);
  ok(/src="x"/.test(colle), "l'attribut précédent garde son guillemet fermant");
  const pixel = sanitizeHtml(`<img alt="a"src="https://t.example/p.gif">`);
  ok(pixel.blocked === 1 && !/(?<!data-blocked-)src="https/.test(pixel.html), `pixel collé bloqué — ${pixel.html}`);
  ok(!/javascript/i.test(sanitizeHtml(`<a href=" javascript:alert(1)">x</a>`).html), "javascript: précédé d'un espace neutralisé");
  ok(!/image-set/i.test(sanitizeHtml(`<div style="background:image-set('https://t.example/p.png' 1x)">x</div>`).html),
     "image-set() retiré comme url()");

  // Un nom affiché encodé ne doit pas pouvoir fournir l'adresse.
  const nom = Buffer.from("PayPal <service@paypal.com>").toString("base64");
  const usurpe = parseAddress(`=?utf-8?B?${nom}?= <attaquant@evil.example>`);
  eq(usurpe.email, "attaquant@evil.example", "l'adresse réelle l'emporte sur celle du nom encodé");
  eq(parseAddress("=?utf-8?Q?Ren=C3=A9?= <rene@x.fr>").name, "René", "le nom est toujours décodé");
  eq(parseAddress("rene@x.fr").email, "rene@x.fr", "adresse nue");

  // Une base64 abîmée ne doit plus jamais lever d'exception.
  const dec = (s) => new TextDecoder().decode(b64decode(s));
  eq(dec("aGVsbG8=aGVsbG8="), "hellohello", "rembourrage au milieu : deux morceaux");
  eq(dec("aGVsbG8gd29ybGQ"), "hello world", "rembourrage absent");
  eq(dec("aGVs\r\nbG8=\r\n"), "hello", "retours à la ligne ignorés");
  ok((() => { try { b64decode("aGVsbG8gd"); return true; } catch { return false; } })(), "base64 tronquée : pas d'exception");
}
{
  const { sameOriginWrite } = await import("./src/auth.js");
  const req = (method, headers = {}) => new Request("https://mail.agentxr.app/api/send", { method, headers });
  ok(sameOriginWrite(req("GET", { "Sec-Fetch-Site": "cross-site" })), "une lecture passe toujours");
  ok(sameOriginWrite(req("POST", { "Sec-Fetch-Site": "same-origin" })), "l'app elle-même passe");
  ok(!sameOriginWrite(req("POST", { "Sec-Fetch-Site": "same-site" })), "un autre *.agentxr.app est refusé");
  ok(!sameOriginWrite(req("POST", { "Sec-Fetch-Site": "cross-site" })), "un site tiers est refusé");
  ok(!sameOriginWrite(req("POST", { Origin: "https://save.agentxr.app" })), "Origin étrangère refusée");
  ok(sameOriginWrite(req("POST", { Origin: "https://mail.agentxr.app" })), "Origin identique acceptée");
  ok(sameOriginWrite(req("POST", { "X-Session": "t", "Sec-Fetch-Site": "cross-site" })), "l'extension (X-Session) passe");
  ok(sameOriginWrite(req("POST")), "sans en-tête de navigateur : pas une page piégée");
}

console.log("\n-- octets 8 bits (0x80-0x9F) ---------------");
{
  const { bytesToLatin1, latin1ToBytes } = await import("./src/rfc822.js");
  const utf8 = (s) => new TextEncoder().encode(s);
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  const tous = Uint8Array.from({ length: 256 }, (_, i) => i);
  eq([...latin1ToBytes(bytesToLatin1(tous))], [...tous], "les 256 octets survivent à l'aller-retour");
  eq(bytesToLatin1(new Uint8Array([0x80])).charCodeAt(0), 0x80, "0x80 reste 0x80, pas U+20AC (windows-1252)");
  const gros = new Uint8Array(100_000).fill(0x9c);
  eq(bytesToLatin1(gros).length, 100_000, "un gros tampon passe sans faire sauter la pile");

  // €, tiret cadratin et guillemets courbes : E2 82 AC, E2 80 94, E2 80 9C —
  // exactement les octets que windows-1252 réécrivait.
  const texte = "Prix : 20 € — “ok” …";
  const simple = concat(
    utf8("Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"),
    utf8(texte)
  );
  eq(parseMessage(simple).text, texte, "corps UTF-8 en 8bit intact");

  const binaire = new Uint8Array([0x00, 0x80, 0x81, 0x8d, 0x90, 0x9d, 0x9f, 0xff]);
  const mixte = concat(
    utf8('Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    utf8(texte),
    utf8('\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="x.bin"\r\nContent-Transfer-Encoding: binary\r\n\r\n'),
    binaire,
    utf8("\r\n--b--\r\n")
  );
  const lu = parseMessage(mixte);
  eq(lu.text, texte, "texte 8bit intact dans un multipart");
  eq([...latin1ToBytes(lu.attachments[0].body)], [...binaire], "pièce jointe 8bit/binaire intacte, octet pour octet");
}

console.log("\n-- en-têtes UTF-8 bruts (RFC 6532) ---------");
{
  const { bytesToLatin1 } = await import("./src/rfc822.js");
  const fil = (s) => bytesToLatin1(new TextEncoder().encode(s)); // comme reçu d'IMAP
  eq(decodeWords(fil("café")), "café", "UTF-8 brut décodé");
  eq(decodeWords("caf\xe9"), "café", "latin1 brut laissé tel quel");
  eq(decodeWords(fil("Re: été ") + "=?utf-8?Q?=C3=A0_Brest?="), "Re: été à Brest", "brut et encodé mélangés");
  eq(decodeWords("=?utf-8?Q?=C3=A0?= " + fil("ça")), "à ça", "l'espace avant un passage brut est gardé");
  eq(decodeWords("日本語"), "日本語", "texte déjà décodé non retouché");
  eq(decodeWords("plain ascii"), "plain ascii", "ASCII intact");
  const h = parseMessage(fil("Subject: Réunion à 14 h\r\nFrom: Zoé Durand <zoe@x.fr>\r\n\r\nx")).headers;
  eq(decodeWords(h.subject), "Réunion à 14 h", "sujet UTF-8 brut d'un vrai message");
  eq(parseAddress(h.from).name, "Zoé Durand", "nom d'expéditeur UTF-8 brut");
}

console.log("\n-- noms de fichiers RFC 2231 ---------------");
{
  eq(parseParams("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf").params.filename, "résumé.pdf", "filename* encodé");
  eq(
    parseParams("attachment; filename*0*=utf-8''r%C3%A9; filename*1*=sum%C3%A9; filename*2=\".pdf\"").params.filename,
    "résumé.pdf",
    "suites filename*0* / *1* / *2"
  );
  eq(parseParams("application/pdf; name*=iso-8859-1'fr'r%E9sum%E9.pdf").params.name, "résumé.pdf", "name* en iso-8859-1, avec langue");
  eq(
    parseParams("attachment; filename=\"repli.pdf\"; filename*=utf-8''vrai.pdf").params.filename,
    "vrai.pdf",
    "la forme étendue l'emporte sur le repli"
  );
  eq(parseParams("attachment; filename*0=\"long\"; filename*1=\"nom.txt\"").params.filename, "longnom.txt", "suites non encodées");
  eq(parseParams("attachment; filename=\"simple.pdf\"").params.filename, "simple.pdf", "nom ordinaire inchangé");

  const msg = parseMessage(
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
      "--b\r\nContent-Type: application/pdf; name*=utf-8''CV%20r%C3%A9sum%C3%A9.pdf\r\n" +
      "Content-Disposition: attachment;\r\n filename*0*=utf-8''CV%20r%C3%A9;\r\n filename*1*=sum%C3%A9.pdf\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\nAAAA\r\n--b--\r\n"
  );
  eq(msg.attachments[0]?.filename, "CV résumé.pdf", "pièce jointe nommée de bout en bout");

  const parts = flattenStructure(
    parseSexp(
      '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 2 1)' +
        "(\"APPLICATION\" \"PDF\" (\"NAME*\" \"utf-8''r%C3%A9sum%C3%A9.pdf\") NIL NIL \"BASE64\" 100 NIL " +
        "(\"ATTACHMENT\" (\"FILENAME*\" \"utf-8''r%C3%A9sum%C3%A9.pdf\")) NIL) \"MIXED\")"
    )
  );
  eq(parts[1]?.filename, "résumé.pdf", "BODYSTRUCTURE : FILENAME* décodé");
}

console.log("\n-- fils et References -----------------------");
{
  const { threadKeyOf, replyReferences, trimReferences, messageIds } = await import("./src/mime.js");
  const { splitMessage } = await import("./src/rfc822.js");
  const racine = { "message-id": "<root@x>", subject: "Dîner" };
  const reponse = { "message-id": "<b@x>", "in-reply-to": "<root@x>", references: "<root@x>", subject: "Re: Dîner" };
  const suite = { "message-id": "<c@x>", "in-reply-to": "<b@x>", references: "<root@x>\r\n <b@x>", subject: "Re: Re: Dîner" };
  eq(threadKeyOf(racine), "<root@x>", "une racine est rangée sous son propre Message-ID");
  eq(threadKeyOf(reponse), threadKeyOf(racine), "la réponse rejoint la racine");
  eq(threadKeyOf(suite), threadKeyOf(racine), "la réponse à la réponse aussi");
  eq(threadKeyOf({ "message-id": "<d@x>", "in-reply-to": "<root@x>" }), "<root@x>", "In-Reply-To seul suffit");
  eq(threadKeyOf({ subject: "Re: Sans id" }), "sans id", "sans aucun id : le sujet");
  eq(threadKeyOf({ references: "(commentaire) <root@x> <b@x>" }), "<root@x>", "commentaire ignoré dans References");

  eq(replyReferences({ mid: "<c@x>", refs: "<root@x> <b@x>" }), ["<root@x>", "<b@x>", "<c@x>"], "chaîne du parent + parent");
  eq(replyReferences({ mid: "<b@x>", refs: "", thread_key: "<root@x>" }), ["<root@x>", "<b@x>"], "ligne ancienne : la racine via thread_key");
  eq(replyReferences({ mid: "<root@x>", refs: "", thread_key: "<root@x>" }), ["<root@x>"], "répondre à la racine : pas de doublon");
  eq(replyReferences({ mid: "<b@x>", refs: "", thread_key: "dîner" }), ["<b@x>"], "clé de sujet ignorée");
  eq(replyReferences(null), [], "pas de parent, pas de chaîne");

  const ids = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`);
  const court = trimReferences(ids);
  eq(court.length, 20, "chaîne bornée à 20");
  eq(court[0], "<m0@x>", "la racine est gardée");
  eq(court[19], "<m29@x>", "le plus récent est gardé");

  const parent = { mid: "<c@x>", refs: "<root@x> <b@x>" };
  const sortant = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re: Dîner", text: "ok",
    inReplyTo: parent.mid, references: replyReferences(parent),
  });
  ok(/^References: <root@x> <b@x> <c@x>\r?$/m.test(sortant), "References = chaîne du parent + parent");
  const ancien = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re", text: "ok", inReplyTo: "<p@x>", references: "<p@x>",
  });
  ok(/^References: <p@x>\r?$/m.test(ancien), "plus jamais <p> <p>");
  const longue = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re", text: "ok",
    inReplyTo: "<fin@x>", references: ids.map((id) => id.replace("@x", "@" + "a".repeat(60) + ".example")),
  });
  ok(longue.split("\r\n").every((l) => l.length <= 998), "aucune ligne d'en-tête au-delà de 998 octets");
  eq(messageIds(parseHeaders(splitMessage(longue).head).references).length, 20, "chaîne repliée relue entière");
}

console.log("\n-- réconciliation (fenêtres, deux essais) --");
{
  const { planWindow, strikes, flagState, uidSet, inRanges } = await import("./src/reconcile.js");
  eq(uidSet([10, 9, 1, 2, 3, 7, 3]), "1:3,7,9:10", "jeu de UID compressé");
  eq(uidSet([]), "", "jeu vide");

  const all = Array.from({ length: 1000 }, (_, i) => i + 1);
  const p1 = planWindow({ all, first: 1, last: 1000, rc: 0 });
  eq(p1.ranges, [[901, 1000], [651, 900]], "premier passage : le haut, puis un bloc");
  eq(p1.nextRc, 651, "la rotation reprend sous ce bloc");
  eq(p1.uids.length, 350, "100 récents + 250 anciens");

  // Une rotation complète couvre first..last sans trou, même avec des UID
  // supprimés, et finit par revenir en haut.
  const trous = all.filter((u) => u % 7 && !(u > 300 && u < 420));
  const vus = new Set();
  let rc = 0;
  let tours = 0;
  for (;;) {
    const p = planWindow({ all: trous, first: 1, last: 1000, rc });
    for (const [a, b] of p.ranges) for (let u = a; u <= b; u++) vus.add(u);
    rc = p.nextRc;
    if (++tours > 20 || p.complete) break;
  }
  eq(vus.size, 1000, "une rotation couvre tout first..last");
  ok(tours < 10, `et se termine (${tours} passages)`);

  const fin = planWindow({ all: [50, 51, 60], first: 1, last: 60, rc: 0 });
  ok(inRanges(10, fin.ranges), "un UID sous le plus vieux survivant est quand même vérifié");
  eq(planWindow({ all: [], first: 1, last: 60, rc: 0 }).ranges, [[1, 60]], "boîte vidée ailleurs : tout est vérifié");

  const s = strikes([5, 7], [7, 900], [[1, 100]]);
  eq(s.doomed, [7], "deuxième absence : supprimé");
  eq(s.miss, [5, 900], "première absence notée, l'ancienne hors fenêtre attend");
  eq(strikes([], [7], [[1, 100]]).miss, [], "revenu entre-temps : oublié");

  eq(flagState("\x5cSeen \x5cFlagged"), { unread: 0, starred: 1 }, "lu et suivi");
  eq(flagState(""), { unread: 1, starred: 0 }, "ni lu ni suivi");
  eq(flagState("\x5cSeenX"), { unread: 1, starred: 0 }, "un mot-clé voisin ne compte pas");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} assertions passées, ${fail} échec(s)\n`);
process.exit(fail ? 1 : 0);
