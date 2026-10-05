// Synthetic Moodle 4.5 (Boost) markup modelled on moodle.vinci.be courses.
import { O } from './harness.js';

export const cm = (id, type, name, inner = '') => `
<li class="activity activity-wrapper ${type} modtype_${type}" id="module-${id}" data-for="cmitem" data-id="${id}">
  <div class="activity-item" data-activityname="${name}">
    ${type === 'label' ? '' : `<div class="activityname"><a href="${O}/mod/${type}/view.php?id=${id}" class="aalink"><span class="instancename">${name} <span class="accesshide"> Fichier</span></span></a></div>`}
    ${inner}
  </div>
</li>`;

// Real Moodle 4.5 header: hidden bulk-select label + collapse/expand screen-reader text around the
// title (this is what produced "Select section X Collapse Expand X" before the fix).
export const sectionHeader = (id, num, title, tag = 'h3') => `
  <div class="course-section-header d-flex" data-for="section_title" data-id="${id}" data-number="${num}">
    <div class="d-flex align-items-start position-relative">
      <div class="bulkselect d-none" data-for="sectionBulkSelect"><input type="checkbox" id="sc${id}"><label class="visually-hidden" for="sc${id}">Select section ${title}</label></div>
      <a role="button" data-toggle="collapse" href="#c${id}" class="btn btn-icon me-3 icons-collapse-expand"><span class="expanded-icon"><span class="sr-only">Collapse</span></span><span class="collapsed-icon"><span class="sr-only">Expand</span></span></a>
      <${tag} class="h4 sectionname course-content-item" data-for="section_title" data-id="${id}" data-number="${num}">${title}</${tag}>
    </div>
    ${num === 0 ? '<div class="flex-fill d-flex justify-content-end"><a href="#" class="section-collapsemenu"><span class="collapseall">Collapse all</span><span class="expandall">Expand all</span></a></div>' : ''}
  </div>`;

export const section = (id, num, title, items, { summary = '', withList = true } = {}) => `
<li class="section course-section main" data-for="section" data-id="${id}" data-number="${num}">
  ${sectionHeader(id, num, title)}
  <div class="content">${summary ? `<div class="summarytext">${summary}</div>` : ''}
    ${withList ? `<ul class="section" data-for="cmlist">${items}</ul>` : ''}
  </div>
</li>`;

export const delegated = (id, title, items) => `
<div class="delegated-section" data-for="section" data-id="${id}">
  ${sectionHeader(id, 9, title, 'h4')}
  <ul data-for="cmlist">${items}</ul>
</div>`;

export const coursePage = (sectionsHtml, title = 'BINV1010-1 Algorithmique') => `<!doctype html><html>
<head><title>Cours : ${title}</title></head>
<body class="course-462 path-course pagelayout-course">
  <div class="drawer drawer-left"><div id="courseindex">
    <li class="courseindex-section" data-for="section" data-id="999"><a href="#">Index entry (must be ignored)</a></li>
  </div></div>
  <div id="page-header"><div class="page-header-headings"><h1>${title}</h1></div></div>
  <section id="region-main"><div class="course-content"><ul class="topics" data-for="course_sectionlist">${sectionsHtml}</ul></div></section>
  <aside data-region="blocks-column"><a href="${O}/mod/quiz/startattempt.php?cmid=5&sesskey=abc">Attempt (must never be fetched)</a></aside>
</body></html>`;

export const crumbs = (...c) => `<div id="page-navbar"><nav><ol class="breadcrumb">${c.map((x) => `<li class="breadcrumb-item">${x}</li>`).join('')}</ol></nav></div>`;

// Boost 4.x activity page: header (intro/dates) inside #region-main, before [role=main].
export const activityPage = ({ body = '', header = '', breadcrumb = '', after = '' } = {}) => `<html><body>
${breadcrumb}
<section id="region-main">
  ${header ? `<div class="activity-header">${header}</div>` : ''}
  <div role="main">${body}</div>
</section>${after}</body></html>`;

export const html = (body) => ({ type: 'text/html; charset=utf-8', body });
export const file = (body = 'BYTES', type = 'application/pdf', extra = {}) => ({ type, body, ...extra });

/** Full course used by most e2e tests. Pass overrides to tweak pages. */
export function mathCourse({ lessonExport = true, extraLessonMenu = '' } = {}) {
  const sections =
    section(10, 0, 'Généralités', [
      cm(1, 'forum', 'Annonces'),
      cm(2, 'resource', 'APOO Slides01', `
        <div class="activity-altcontent"><p>Slides du cours 1</p></div>
        <div data-region="completionrequirements"><button>À faire</button></div>`),
    ].join(''), { summary: '<p>Bienvenue <b>au cours</b></p>' }) +
    section(11, 1, 'Chapitre 1 : Logique Formelle', [
      cm(3, 'subsection', 'Théorie', delegated(20, 'Théorie', [
        cm(4, 'page', 'Manuel IntelliJ'),
        cm(5, 'quiz', 'Semaine 1 : test de révision', `
          <div data-region="activity-dates">
            <div><strong>Ouvert :</strong> lundi 15 septembre 2025, 00:00</div>
            <div><strong>Fermé :</strong> dimanche 25 octobre 2099, 23:59</div>
          </div>`),
      ].join(''))),
      cm(6, 'label', '1ère Séance - Les puzzles', `
        <div class="activity-altcontent">
          <h4>1ère Séance - Les puzzles</h4>
          <p>Voir <a href="${O}/pluginfile.php/55/mod_label/intro/enonce.pdf">énoncé</a> et <a href="${O}/mod/resource/view.php?id=2">les slides</a></p>
        </div>`),
      cm(7, 'folder', 'Ressources fiche 2'),
      cm(8, 'lesson', 'Semaine 2 - Parcours Excel'),
      cm(9, 'url', 'Doc Java'),
      cm(12, 'assign', 'Projet 1'),
    ].join('')) +
    section(13, 2, 'Chapitre 2', '', { withList: false }); // content missing → section.php

  const pages = {
    '/mod/resource/view.php?id=2&redirect=1': file('%PDF-slides', 'application/pdf', {
      redirect: '/pluginfile.php/77/mod_resource/content/1/APOO%20Slides01.pdf',
      cd: "inline; filename*=UTF-8''APOO%20Slides01.pdf",
    }),
    '/pluginfile.php/55/mod_label/intro/enonce.pdf': file('%PDF-enonce'),
    '/mod/page/view.php?id=4': html(activityPage({
      breadcrumb: crumbs('BINV1010', 'Chapitre 1 : Logique Formelle', 'Théorie', 'Manuel IntelliJ'),
      header: `<div class="activity-description" id="intro"><div class="no-overflow"><p>INTRO DU MANUEL</p></div></div>`,
      body: `<div class="box generalbox center"><div class="no-overflow">
        <h2>Installation</h2>
        <p style="color: rgb(224, 62, 45);">Erratum : la version 2024 est requise</p>
        <ol><li>Télécharger</li><li>Installer<ul><li>Windows</li></ul></li></ol>
        <img src="${O}/pluginfile.php/88/mod_page/content/3/capture.png" alt="capture">
        <iframe src="https://www.youtube.com/embed/abc123"></iframe>
      </div></div>`,
    })),
    '/pluginfile.php/88/mod_page/content/3/capture.png': file('PNG', 'image/png'),
    '/mod/quiz/view.php?id=5': html(activityPage({
      breadcrumb: crumbs('BINV1010', 'Chapitre 1 : Logique Formelle', 'Théorie', 'Semaine 1'),
      header: `<div class="activity-description" id="intro"><p>Test sur la logique propositionnelle</p></div>`,
      body: `<div class="box quizinfo"><p>Tentatives autorisées : 1</p><p>Note pour passer : 5,00 sur 10,00</p></div>
        <div class="quizattempt"><form method="post" action="${O}/mod/quiz/startattempt.php"><input type="hidden" name="sesskey" value="abc"><button>Faire le test</button></form>
        <a href="${O}/mod/quiz/startattempt.php?cmid=5&sesskey=abc">Commencer</a></div>`,
    })),
    '/mod/folder/view.php?id=7': html(activityPage({
      body: `<div id="folder_tree0" class="foldertree"><ul>
        <li><span class="fp-filename-icon"><a href="${O}/pluginfile.php/99/mod_folder/content/0/fiche2.pdf?forcedownload=1">fiche2.pdf</a></span></li>
        <li><span class="fp-filename-icon"><a href="${O}/pluginfile.php/99/mod_folder/content/0/Sous%20dossier/data.xlsx?forcedownload=1">data.xlsx</a></span></li>
      </ul></div>
      <form method="post" action="${O}/mod/folder/download_folder.php"><input name="sesskey" value="abc"><button>Télécharger le dossier</button></form>`,
    })),
    '/pluginfile.php/99/mod_folder/content/0/fiche2.pdf?forcedownload=1': file('x', 'application/pdf', { cd: 'attachment; filename="fiche2.pdf"' }),
    '/pluginfile.php/99/mod_folder/content/0/Sous%20dossier/data.xlsx?forcedownload=1': file('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    '/mod/lesson/view.php?id=8': html(`<html><body>
      ${crumbs('BINV1010', 'Chapitre 1 : Logique Formelle', 'Semaine 2')}
      <section id="region-main"><div role="main">
        <div class="box contents"><p>Intro page</p></div>
        <a href="${O}/mod/lesson/continue.php?id=8&pageid=100">Suivante</a>
        ${lessonExport ? `<a href="${O}/local/lessonexport/export.php?id=8&type=pdf">Export as PDF</a>` : ''}
      </div></section>
      <aside><section class="block_fake"><div class="menuwrapper"><ul>
        <li class="selected">1. Introduction</li>
        <li><a href="${O}/mod/lesson/view.php?id=8&pageid=101">2. Référence</a></li>
        ${extraLessonMenu}
      </ul></div></section></aside></body></html>`),
    '/local/lessonexport/export.php?id=8&type=pdf': file('%PDF-lesson', 'application/pdf', { cd: 'attachment; filename="Semaine 2.pdf"' }),
    '/mod/lesson/view.php?id=8&pageid=101': html(activityPage({ body: '<div class="box contents"><p>Contenu référence</p></div>' })),
    '/mod/url/view.php?id=9&forceview=1': html(activityPage({ body: `<div class="urlworkaround">Cliquez sur <a href="https://docs.oracle.com/java">https://docs.oracle.com/java</a></div>` })),
    '/mod/assign/view.php?id=12': html(activityPage({
      header: `<div data-region="activity-dates">
          <div><strong>Ouvert le :</strong> lundi 1 septembre 2025, 00:00</div>
          <div><strong>À remettre :</strong> vendredi 3 octobre 2025, 23:59</div></div>
        <div class="activity-description" id="intro"><p>Faire le projet</p>
          <div data-region="intro-attachments"><a href="${O}/pluginfile.php/5/mod_assign/introattachment/0/consignes.pdf?forcedownload=1">consignes.pdf</a></div></div>`,
      body: `<div class="submissionstatustable"><table>
        <tr><th>Statut des travaux remis</th><td>Aucune tentative</td></tr>
        <tr><th>Date limite</th><td>samedi 4 octobre 2025, 23:59</td></tr></table></div>`,
    })),
    '/pluginfile.php/5/mod_assign/introattachment/0/consignes.pdf?forcedownload=1': file('x'),
    '/mod/forum/view.php?id=1': html(activityPage({
      body: `<table class="discussion-list"><tbody>${Array.from({ length: 12 }, (_, i) =>
        `<tr class="discussion"><th><a href="${O}/mod/forum/discuss.php?d=${300 + i}">Annonce ${i}</a></th></tr>`).join('')}</tbody></table>`,
    })),
    '/course/section.php?id=13': html(activityPage({
      body: `<ul>${section(13, 2, 'Chapitre 2', cm(14, 'h5pactivity', 'Exercice H5P'))}</ul>`,
    })),
  };
  for (let i = 0; i < 12; i++) {
    pages[`/mod/forum/discuss.php?d=${300 + i}`] = html(activityPage({
      body: `<article data-region="post"><header><h3 data-region-content="forum-post-core-subject">Annonce ${i}</h3>
        <div class="mb-3">par Prof, <time>lundi ${i + 1} septembre 2025, 09:00</time></div></header>
        <div class="post-content-container"><p>Message ${i}</p></div></article>`,
    }));
  }
  return { html: coursePage(sections), pages };
}
