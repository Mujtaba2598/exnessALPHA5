#!/usr/bin/env python3
import asyncio
import json
import websockets
import MetaTrader5 as mt5
import numpy as np
from datetime import datetime

class HalalExnessBridge:
    def __init__(self):
        self.connected = False
        self.login = None
        self.server = None
        self.position_history = {}
    
    def calculate_rsi(self, prices, period=14):
        if len(prices) < period + 1:
            return 50
        deltas = np.diff(prices)
        seed = deltas[:period]
        up = seed[seed >= 0].sum() / period
        down = -seed[seed < 0].sum() / period
        if down == 0:
            return 100
        rs = up / down
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    def calculate_macd(self, prices):
        if len(prices) < 26:
            return 0, 0, 0
        ema12 = np.mean(prices[-12:])
        ema26 = np.mean(prices[-26:])
        macd = ema12 - ema26
        signal = np.mean(prices[-9:]) - ema26
        histogram = macd - signal
        return macd, signal, histogram
    
    def calculate_bollinger_bands(self, prices, period=20, std_dev=2):
        if len(prices) < period:
            return None, None, None
        sma = np.mean(prices[-period:])
        std = np.std(prices[-period:])
        upper = sma + (std * std_dev)
        lower = sma - (std * std_dev)
        return upper, sma, lower
    
    def get_ai_signal(self, symbol):
        try:
            rates_m5 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 100)
            if rates_m5 is None or len(rates_m5) < 50:
                return {"action": "HOLD", "confidence": 0, "reasons": ["Insufficient data"]}
            
            closes = [r.close for r in rates_m5]
            current_price = closes[-1]
            
            rsi = self.calculate_rsi(closes)
            macd, signal, histogram = self.calculate_macd(closes)
            bb_upper, bb_middle, bb_lower = self.calculate_bollinger_bands(closes)
            
            momentum = ((closes[-1] - closes[-5]) / closes[-5]) * 100 if len(closes) >= 5 else 0
            
            ma20 = np.mean(closes[-20:]) if len(closes) >= 20 else current_price
            ma50 = np.mean(closes[-50:]) if len(closes) >= 50 else current_price
            
            buy_score = 0
            sell_score = 0
            reasons = []
            
            if rsi < 30:
                buy_score += 25
                reasons.append(f"Oversold RSI {rsi:.1f}")
            elif rsi > 70:
                sell_score += 25
                reasons.append(f"Overbought RSI {rsi:.1f}")
            
            if ma20 > ma50:
                buy_score += 15
                reasons.append("Uptrend")
            else:
                sell_score += 15
                reasons.append("Downtrend")
            
            if momentum > 0.1:
                buy_score += 10
                reasons.append(f"Positive momentum {momentum:.2f}%")
            elif momentum < -0.1:
                sell_score += 10
                reasons.append(f"Negative momentum {momentum:.2f}%")
            
            if bb_lower and current_price <= bb_lower:
                buy_score += 15
                reasons.append("At lower Bollinger Band")
            elif bb_upper and current_price >= bb_upper:
                sell_score += 15
                reasons.append("At upper Bollinger Band")
            
            if histogram > 0:
                buy_score += 10
                reasons.append("Bullish MACD")
            else:
                sell_score += 10
                reasons.append("Bearish MACD")
            
            total_score = buy_score + sell_score
            if total_score > 0:
                buy_confidence = buy_score / total_score
                sell_confidence = sell_score / total_score
                
                if buy_confidence > 0.65:
                    action = "BUY"
                    confidence = buy_confidence
                elif sell_confidence > 0.65:
                    action = "SELL"
                    confidence = sell_confidence
                else:
                    action = "HOLD"
                    confidence = 0.5
            else:
                action = "HOLD"
                confidence = 0.5
            
            print(f"🤖 AI [{symbol}]: {action} ({(confidence*100):.0f}%) | {', '.join(reasons[:2])}")
            
            return {
                "action": action,
                "confidence": confidence,
                "reasons": reasons[:3],
                "currentPrice": current_price,
                "rsi": rsi,
                "momentum": momentum
            }
        except Exception as e:
            print(f"AI error: {e}")
            return {"action": "HOLD", "confidence": 0, "reasons": [str(e)]}
    
    async def should_close_position(self, params):
        try:
            symbol = params.get('symbol')
            current_profit_percent = params.get('currentProfitPercent', 0)
            side = params.get('side')
            holding_time = params.get('holdingTime', 0)
            
            rates_m1 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M1, 0, 30)
            if rates_m1:
                closes = [r.close for r in rates_m1]
                current_rsi = self.calculate_rsi(closes)
                momentum = ((closes[-1] - closes[-3]) / closes[-3]) * 100 if len(closes) >= 3 else 0
            else:
                current_rsi = 50
                momentum = 0
            
            close_reason = None
            should_close = False
            
            if current_profit_percent > 0:
                if current_profit_percent >= 3:
                    should_close = True
                    close_reason = f"High profit {current_profit_percent:.2f}%"
                elif current_profit_percent >= 1.5:
                    if side == 'buy' and momentum < -0.05:
                        should_close = True
                        close_reason = f"Profit {current_profit_percent:.2f}% with weakening momentum"
                    elif side == 'sell' and momentum > 0.05:
                        should_close = True
                        close_reason = f"Profit {current_profit_percent:.2f}% with weakening momentum"
                    elif side == 'buy' and current_rsi > 70:
                        should_close = True
                        close_reason = f"Profit {current_profit_percent:.2f}% with overbought RSI"
                    elif side == 'sell' and current_rsi < 30:
                        should_close = True
                        close_reason = f"Profit {current_profit_percent:.2f}% with oversold RSI"
                
                if not should_close and holding_time > 7200 and current_profit_percent > 0.5:
                    should_close = True
                    close_reason = f"Position open 2+ hours with {current_profit_percent:.2f}% profit"
            
            elif current_profit_percent < 0:
                loss_percent = abs(current_profit_percent)
                if loss_percent >= 2:
                    should_close = True
                    close_reason = f"Stop loss {loss_percent:.2f}%"
            
            if should_close:
                print(f"🎯 CLOSE {symbol} | Profit: {current_profit_percent:.2f}% | {close_reason}")
            
            return {"close": should_close, "reason": close_reason or "Holding"}
        except Exception as e:
            print(f"Close decision error: {e}")
            return {"close": abs(params.get('currentProfitPercent', 0)) > 1.5, "reason": "Default rule"}
    
    async def handle_connection(self, websocket):
        print("✅ Client connected to Halal Bridge")
        
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_id = data.get('id')
                    action = data.get('action')
                    params = data.get('params', {})
                    
                    result = None
                    
                    if action == 'connect':
                        login = params.get('login')
                        password = params.get('password')
                        server = params.get('server')
                        
                        if not mt5.initialize():
                            result = {"success": False, "error": "MT5 init failed"}
                        else:
                            authenticated = mt5.login(login, password=password, server=server)
                            if authenticated:
                                account_info = mt5.account_info()
                                balance = account_info.balance if account_info else 0
                                self.connected = True
                                result = {"success": True, "data": {"balance": balance}}
                            else:
                                result = {"success": False, "error": "Login failed"}
                    
                    elif action == 'getBalance':
                        account_info = mt5.account_info()
                        result = {"success": True, "data": account_info.balance if account_info else 0}
                    
                    elif action == 'getSignal':
                        symbol = params.get('symbol')
                        signal = self.get_ai_signal(symbol)
                        result = {"success": True, "data": signal}
                    
                    elif action == 'shouldClosePosition':
                        close_decision = await self.should_close_position(params)
                        result = {"success": True, "data": close_decision}
                    
                    elif action == 'getPrice':
                        symbol = params.get('symbol')
                        tick = mt5.symbol_info_tick(symbol)
                        if tick:
                            result = {"success": True, "data": {"bid": tick.bid, "ask": tick.ask}}
                        else:
                            result = {"success": False, "error": f"No price for {symbol}"}
                    
                    elif action == 'placeOrder':
                        symbol = params.get('symbol')
                        volume = params.get('volume')
                        side = params.get('side')
                        
                        order_type = mt5.ORDER_TYPE_BUY if side == 'buy' else mt5.ORDER_TYPE_SELL
                        price = mt5.symbol_info_tick(symbol).ask if side == 'buy' else mt5.symbol_info_tick(symbol).bid
                        
                        request = {
                            "action": mt5.TRADE_ACTION_DEAL,
                            "symbol": symbol,
                            "volume": volume,
                            "type": order_type,
                            "price": price,
                            "deviation": 20,
                            "magic": 234001,
                            "comment": "Halal AI Bot",
                            "type_time": mt5.ORDER_TIME_GTC,
                            "type_filling": mt5.ORDER_FILLING_IOC,
                        }
                        
                        order_result = mt5.order_send(request)
                        if order_result.retcode == mt5.TRADE_RETCODE_DONE:
                            result = {"success": True, "data": {"orderId": order_result.order, "price": price}}
                        else:
                            result = {"success": False, "error": f"Order failed: {order_result.comment}"}
                    
                    elif action == 'closeOrder':
                        order_id = params.get('orderId')
                        position = mt5.positions_get(ticket=order_id)
                        if position:
                            close_request = {
                                "action": mt5.TRADE_ACTION_DEAL,
                                "symbol": position[0].symbol,
                                "volume": position[0].volume,
                                "type": mt5.ORDER_TYPE_SELL if position[0].type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY,
                                "position": order_id,
                                "price": mt5.symbol_info_tick(position[0].symbol).bid if position[0].type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(position[0].symbol).ask,
                                "deviation": 20,
                                "magic": 234001,
                                "comment": "Close by AI",
                                "type_time": mt5.ORDER_TIME_GTC,
                                "type_filling": mt5.ORDER_FILLING_IOC,
                            }
                            close_result = mt5.order_send(close_request)
                            if close_result.retcode == mt5.TRADE_RETCODE_DONE:
                                result = {"success": True, "data": {"orderId": close_result.order}}
                            else:
                                result = {"success": False, "error": f"Close failed: {close_result.comment}"}
                        else:
                            result = {"success": False, "error": "Position not found"}
                    
                    if result:
                        response = {"id": msg_id, "success": result["success"], "data": result.get("data"), "error": result.get("error")}
                        await websocket.send(json.dumps(response))
                
                except Exception as e:
                    print(f"Error: {e}")
                    await websocket.send(json.dumps({"id": msg_id, "success": False, "error": str(e)}))
        
        except websockets.exceptions.ConnectionClosed:
            print("Client disconnected")
        finally:
            if self.connected:
                mt5.shutdown()
                self.connected = False

async def main():
    print("\n" + "="*60)
    print("🕋 100% HALAL EXNESS BRIDGE")
    print("="*60)
    print("✅ WebSocket: ws://localhost:5001")
    print("✅ Waiting for Node.js bot...\n")
    
    bridge = HalalExnessBridge()
    async with websockets.serve(bridge.handle_connection, "localhost", 5001):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
