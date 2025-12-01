import { renderToString } from './lib/components';
import { App } from './components/app';

export const render = () => renderToString(App, {client: false});
