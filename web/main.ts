import { SCENES } from '../shared/protocol';
document.querySelector('#app')!.insertAdjacentHTML('beforeend', `<p>${SCENES.join(' · ')}</p>`);
