import { parseAX } from './loop.mjs';

const elements = o => parseAX(o.ax);
const fields = o => elements(o).filter(e => ['search text field', 'search field', 'text field', 'combo box'].includes(e.role) && /searchInput|Wikipedia内を検索|Search Wikipedia/.test(e.label));
const fieldValue = o => fields(o)[0]?.label.match(/(?:^|, )Value: (.*?)(?=, (?:ID|Help|Description):|$)/)?.[1] ?? '';
const article = (o, title) => {
  try { return decodeURIComponent(new URL(o.url).pathname) === '/wiki/' + title.replaceAll(' ', '_') &&
    elements(o).some(e => e.role === 'heading' && e.label.includes(title) && e.label.includes('firstHeading')); }
  catch { return false; }
};
const section = (o, title, heading) => {
  try { return article(o, title) && decodeURIComponent(new URL(o.url).hash) === '#' + heading; }
  catch { return false; }
};
const toc = o => elements(o).find(e => e.label.includes('vector-page-titlebar-toc-checkbox'));

/** Read-only Wikipedia search scenario. Parameters are included in the resume signature. */
export function createWikipediaWorkflow(entries = [
  { title: '東京スカイツリー', section: '歴史' },
  { title: '東京タワー', section: '沿革' },
  { title: '東京都庁舎', section: '施設' },
]) {
  if (!entries.length || entries.some(e => typeof e.title !== 'string' || typeof e.section !== 'string')) throw new TypeError('Invalid entries');
  const stages = [];
  entries.forEach(({ title, section: heading }, index) => {
    const previousPage = o => {
      try { return index ? article(o, entries[index - 1].title) :
        decodeURIComponent(new URL(o.url).pathname) === '/wiki/メインページ'; }
      catch { return false; }
    };
    const add = s => stages.push({ maxActions: 2, resources: {}, canRetry: () => false,
      ...s, progress: o => s.verify(o) });
    add({ id: `article-${index}-open-search`, goal: 'Open the Wikipedia search input. Click 検索 search link.',
      actions: ['click_element'], ready: previousPage,
      verify: o => previousPage(o) && fields(o).length === 1,
      acceptTarget: e => e.role === 'link' && /Description: 検索(?:,|$)/.test(e.label),
    });
    add({ id: `article-${index}-input`, goal: 'Replace the Wikipedia search input with the provided article title.',
      actions: ['set_value'], ready: o => previousPage(o) && fields(o).length === 1,
      verify: o => previousPage(o) && fields(o).length === 1 && fieldValue(o) === title,
      acceptTarget: (e, o) => fields(o).some(f => f.index === e.index),
      resources: { text: title }, canRetry: o => previousPage(o) && fields(o).length === 1,
    });
    add({ id: `article-${index}-search`, goal: 'Click the Search 検索 button to open the article.',
      actions: ['click_element'], ready: o => previousPage(o) && fieldValue(o) === title,
      verify: o => article(o, title),
      acceptTarget: e => e.role === 'button' && /(?:Search|検索)/.test(e.label),
      canRetry: o => previousPage(o) && fieldValue(o) === title,
    });
    add({ id: `article-${index}-toc`, goal: 'Expand the table of contents using 目次の表示・非表示を切り替え.',
      actions: ['click_element'], ready: o => article(o, title),
      verify: o => article(o, title) && Boolean(toc(o)?.label.includes('(expanded)')),
      acceptTarget: e => e.label.includes('vector-page-titlebar-toc-checkbox'),
    });
    add({ id: `article-${index}-section`, goal: `Click the table of contents link ${heading} to jump to that section.`,
      actions: ['click_element'], ready: o => article(o, title) && Boolean(toc(o)?.label.includes('(expanded)')),
      verify: o => section(o, title, heading),
      acceptTarget: e => e.role === 'link' && e.label.includes(` ${heading},`) && !e.label.includes('編集'),
      canRetry: o => article(o, title) && Boolean(toc(o)?.label.includes('(expanded)')),
    });
  });
  const last = entries.at(-1);
  return { id: 'wikipedia-three-articles', version: '2', parameters: entries,
    guard: o => { try { return new URL(o.url).origin === 'https://ja.wikipedia.org'; } catch { return false; } },
    verify: o => section(o, last.title, last.section), stages };
}
