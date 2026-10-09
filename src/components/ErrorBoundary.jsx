import React from 'react';
import './ErrorBoundary.css';

// 畫面崩潰時的保護網：任何子元件 render 拋錯，原本整頁會變空白（React 會卸載整棵樹），
// 這裡改成顯示錯誤說明 + 重試 / 重新整理，錯誤細節寫到 console 供除錯。
// main.jsx 包整個 App；ManagerInterface 另外包住分頁內容（resetKey = 路徑），
// 一個分頁壞掉不會連帶整個管理介面，切到別的分頁就自動恢復。
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { scope = 'page' } = this.props;
    return (
      <div className={`error-boundary error-boundary--${scope}`} role="alert">
        <div className="error-boundary__card">
          <h2 className="error-boundary__title">這個畫面發生錯誤</h2>
          <p className="error-boundary__text">
            {scope === 'panel'
              ? '此分頁暫時無法顯示，其他分頁不受影響。已輸入但尚未儲存的內容可能需要重新填寫。'
              : '系統暫時無法顯示此頁面。請重新整理；若持續發生，請聯絡管理員。'}
          </p>
          <code className="error-boundary__detail">{String(this.state.error?.message || this.state.error)}</code>
          <div className="error-boundary__actions">
            {scope === 'panel' && (
              <button type="button" className="error-boundary__btn error-boundary__btn--ghost" onClick={() => this.setState({ error: null })}>
                重試
              </button>
            )}
            <button type="button" className="error-boundary__btn" onClick={() => window.location.reload()}>
              重新整理
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
