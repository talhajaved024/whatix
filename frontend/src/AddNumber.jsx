import {SESSION,campaignNumber,openInbox,rememberCampaign} from './inbox.js';
import {refreshMyCampaigns,useMyCampaigns} from './campaign-directory.js';
import Dropdown from './components/Dropdown.jsx';
import Icon from './components/Icon.jsx';
import './campaigns.css';

// Admins switch between every connected number; a regular user between the
// campaign numbers assigned to them. Switching reloads into that inbox.
// The list comes from the tab's shared /my-campaigns poller, which keeps the
// last answer, so the picker stays in place while switching inboxes.
export function InboxSwitcher({sending=false,admin=true,username}){
  const state=useMyCampaigns(true);
  const directory=state?.sessions?state:null;
  const error=state?.error?'Numbers unavailable':'';
  const phoneOf=row=>row.phone||campaignNumber(row);
  const numbers=directory?.sessions.filter(row=>row.status==='WORKING' && phoneOf(row))||[];
  const current=numbers.find(row=>row.name===SESSION);
  const caption=admin?'WhatsApp inbox':'WA number';
  if(!admin && !error && !directory)return null;
  // A single campaign: show which number this is, nothing to switch to.
  if(!admin && !error && numbers.length<2 && current)return <div className="inbox-switcher">
    <div className="inbox-current"><span className="inbox-tile"><Icon name="phone" size={18}/></span>
      <span><small>{caption}</small><strong>+{phoneOf(current)}</strong></span></div></div>;
  function choose(name){
    rememberCampaign(username,name);
    openInbox(name,directory.defaultSession);
  }
  return <div className="inbox-switcher">
    <span className="inbox-caption" aria-hidden="true">{caption}{numbers.length>1&&<small>{numbers.length} numbers</small>}</span>
    <Dropdown variant="rich" icon="phone" label={caption} value={SESSION} disabled={sending || !directory || !!error}
      placeholder={directory ? 'Select a connected number' : 'Checking numbers…'} searchPlaceholder="Search numbers" onChange={choose}
      options={numbers.map((row,i)=>({value:row.name,label:'+'+phoneOf(row),icon:'phone',
        description:admin?row.name:'Number '+(i+1)+' of '+numbers.length}))}/>
    {error && <button type="button" className="inbox-retry" onClick={refreshMyCampaigns}>{error} · Retry</button>}
  </div>;
}

export function AddNumber({sending}){
  return <section id="panel-numbers" role="tabpanel" aria-labelledby="tab-numbers" className="number-dashboard">
    <InboxSwitcher sending={sending}/>
    <iframe title="WAHA dashboard for connecting WhatsApp numbers" src="/api/admin/waha-ui/" referrerPolicy="same-origin"/>
  </section>;
}
