// 렌더 중 예외가 나도 앱 전체(흰 화면) 대신 복구 가능한 폴백을 보여준다.
import { Component, type ReactNode } from "react";

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error) {
    // 콘솔에 남겨 디버깅에 사용.
    console.error("[Plume] 컴포넌트 렌더 오류:", error);
  }
  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="errboundary">
          <div className="errcard">
            <div className="erricon">⚠️</div>
            <h2>화면 렌더 중 오류가 발생했습니다</h2>
            <p className="hint">작업 내용(메모리 상태)은 유지됩니다. 아래 버튼으로 다시 시도하세요.</p>
            <pre className="errmsg">{this.state.error.message}</pre>
            <button className="active" onClick={this.reset}>다시 시도</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
