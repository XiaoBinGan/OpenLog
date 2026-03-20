import { useState } from 'react';
import { Monitor, Server, ChevronDown, Loader } from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';

export default function DeviceSelector() {
  const { selectedDevice, setSelectedDevice, devices, getDeviceStatusColor } = useDevice();
  const [showDropdown, setShowDropdown] = useState(false);
  
  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dark-800 hover:bg-dark-700 border border-dark-700 transition-colors"
      >
        {selectedDevice.id === 'local' ? (
          <Monitor className="w-4 h-4 text-accent-500" />
        ) : (
          <Server className="w-4 h-4 text-green-500" />
        )}
        <span className="text-sm font-medium">{selectedDevice.name}</span>
        <ChevronDown className={`w-4 h-4 text-dark-400 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
      </button>
      
      {showDropdown && (
        <>
          {/* 背景遮罩 */}
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setShowDropdown(false)}
          />
          
          {/* 下拉菜单 */}
          <div className="absolute top-full mt-2 left-0 min-w-[200px] bg-dark-900 border border-dark-700 rounded-xl shadow-xl z-50 overflow-hidden animate-scale-in">
            {devices.map((device) => (
              <button
                key={device.id}
                onClick={() => {
                  setSelectedDevice(device);
                  setShowDropdown(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-800 transition-colors ${
                  selectedDevice.id === device.id ? 'bg-accent-500/10 text-accent-400' : ''
                }`}
              >
                {device.id === 'local' ? (
                  <Monitor className="w-4 h-4" />
                ) : (
                  <Server className="w-4 h-4" />
                )}
                <span className="text-sm flex-1 text-left">{device.name}</span>
                <span className={`w-2 h-2 rounded-full ${getDeviceStatusColor(device)}`} />
              </button>
            ))}
            {devices.length === 1 && (
              <div className="px-3 py-2 text-xs text-dark-500 text-center border-t border-dark-800">
                无已连接的远程服务器
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
