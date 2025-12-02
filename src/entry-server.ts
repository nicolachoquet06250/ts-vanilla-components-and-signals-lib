import { renderToString } from './lib/components';
import { App } from './components/app.new';

export const render = () => renderToString(App, {client: false});
