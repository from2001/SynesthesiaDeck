import { showPageLink } from '../show-settings';

export function isPreviewPage(page: { search: string; pathname: string }): boolean {
  const query = new URLSearchParams(page.search);
  return query.has('view') ? query.get('view') === 'preview' : page.pathname === '/preview';
}

/** Build an audience link with the public endpoint only, never desk credentials. */
export function previewPageLink(pageOrigin: string, serverUrl: string, hosted: boolean): URL {
  const url = showPageLink(pageOrigin, serverUrl, false, hosted);
  url.pathname = '/preview';
  return url;
}
