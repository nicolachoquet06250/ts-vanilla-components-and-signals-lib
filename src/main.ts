import './style.css'
import {mount} from './lib/components';
import {App} from "./components/app.new";

mount(App({client: true}), document.querySelector('#app')!);
