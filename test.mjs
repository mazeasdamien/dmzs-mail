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

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} assertions passées, ${fail} échec(s)\n`);
process.exit(fail ? 1 : 0);
