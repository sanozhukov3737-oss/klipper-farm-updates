import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Copy, RefreshCw, TriangleAlert } from 'lucide-react';
import appIcon from '../assets/app-icon-v1144.png';
import { frontendBuildId } from '../lib/buildInfo';

type Props={children:ReactNode};
type State={error?:Error;copied:boolean};

export class AppErrorBoundary extends Component<Props,State>{
  state:State={copied:false};

  static getDerivedStateFromError(error:Error):State{return{error,copied:false}}
  componentDidCatch(error:Error,info:ErrorInfo){console.error('Klipper Farm UI error',error,info.componentStack)}
  componentDidMount(){window.addEventListener('error',this.onWindowError);window.addEventListener('unhandledrejection',this.onRejection)}
  componentWillUnmount(){window.removeEventListener('error',this.onWindowError);window.removeEventListener('unhandledrejection',this.onRejection)}

  private onWindowError=(event:ErrorEvent)=>{if(event.error instanceof Error)this.setState({error:event.error,copied:false})};
  private onRejection=(event:PromiseRejectionEvent)=>{const error=event.reason instanceof Error?event.reason:new Error(String(event.reason??'Неизвестная ошибка'));this.setState({error,copied:false})};
  private copy=async()=>{const text=`${frontendBuildId}\n${this.state.error?.stack||this.state.error?.message||'Klipper Farm: неизвестная ошибка'}`;try{await navigator.clipboard.writeText(text);this.setState({copied:true})}catch{/* буфер недоступен: подтверждение не покажется, и это честнее ложного «скопировано» */}}
  private resetUi=()=>{['klipper-page','klipper-selected','klipper-theme'].forEach(key=>localStorage.removeItem(key));window.location.reload()};

  render(){
    if(!this.state.error)return this.props.children;
    return <main className="appCrash">
      <section><img src={appIcon} alt="Klipper Farm"/><div className="appCrashIcon"><TriangleAlert/></div><h1>Интерфейс не загрузился</h1><p>Данные принтеров сохранены. Перезапустите интерфейс — вместо чёрного экрана теперь всегда показывается этот экран восстановления.</p><pre>{this.state.error.message}</pre><div><button className="primary" onClick={()=>window.location.reload()}><RefreshCw/> Перезапустить</button><button onClick={this.resetUi}>Сбросить вид интерфейса</button><button onClick={this.copy}><Copy/> {this.state.copied?'Скопировано':'Копировать ошибку'}</button></div>
        <p><small>Сборка: {frontendBuildId}</small></p>
      </section>
    </main>;
  }
}
