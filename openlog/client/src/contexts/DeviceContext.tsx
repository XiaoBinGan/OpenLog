import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { RemoteServer } from '../types';

// 本地设备
const LOCAL_DEVICE = { 
  id: 'local', 
  name: '本地设备', 
  host: 'localhost', 
  status: 'connected' as const 
};

type Device = typeof LOCAL_DEVICE | RemoteServer;

interface DeviceContextType {
  // 当前选中的设备
  selectedDevice: Device;
  setSelectedDevice: (device: Device) => void;
  
  // 所有可用设备
  devices: Device[];
  setDevices: (devices: Device[]) => void;
  
  // 刷新设备列表
  refreshDevices: () => Promise<void>;
  
  // 是否是远程设备
  isRemote: boolean;
  
  // 设备状态颜色
  getDeviceStatusColor: (device: Device) => string;
}

const DeviceContext = createContext<DeviceContextType | null>(null);

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const [selectedDevice, setSelectedDeviceState] = useState<Device>(() => {
    // 从 localStorage 恢复上次选择的设备
    const saved = localStorage.getItem('openlog-selected-device');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return LOCAL_DEVICE;
      }
    }
    return LOCAL_DEVICE;
  });
  
  const [devices, setDevices] = useState<Device[]>([LOCAL_DEVICE]);
  
  // 保存选择到 localStorage
  const setSelectedDevice = useCallback((device: Device) => {
    setSelectedDeviceState(device);
    localStorage.setItem('openlog-selected-device', JSON.stringify(device));
  }, []);
  
  // 刷新设备列表
  const refreshDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/remote/servers');
      if (!res.ok) {
        console.error('Failed to fetch remote servers:', res.status);
        return;
      }
      const data = await res.json();
      const connectedServers = (data.servers || []).filter(
        (s: RemoteServer) => s.status === 'connected'
      );
      setDevices([LOCAL_DEVICE, ...connectedServers]);

      // 如果当前选中的设备不在列表中，重置为本地
      if (selectedDevice.id !== 'local') {
        const stillExists = connectedServers.some((s: RemoteServer) => s.id === selectedDevice.id);
        if (!stillExists) {
          setSelectedDevice(LOCAL_DEVICE);
        }
      }
    } catch (err) {
      console.error('Failed to refresh devices:', err);
    }
  }, [selectedDevice.id, setSelectedDevice]);
  
  // 初始加载和定期刷新
  useEffect(() => {
    refreshDevices();
    const interval = setInterval(refreshDevices, 30000);
    return () => clearInterval(interval);
  }, [refreshDevices]);
  
  const isRemote = selectedDevice.id !== 'local';
  
  const getDeviceStatusColor = useCallback((device: Device) => {
    if (device.id === 'local') return 'bg-green-500';
    if (device.status === 'connected') return 'bg-green-500';
    if (device.status === 'error') return 'bg-red-500';
    return 'bg-gray-500';
  }, []);
  
  return (
    <DeviceContext.Provider value={{
      selectedDevice,
      setSelectedDevice,
      devices,
      setDevices,
      refreshDevices,
      isRemote,
      getDeviceStatusColor,
    }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const context = useContext(DeviceContext);
  if (!context) {
    throw new Error('useDevice must be used within a DeviceProvider');
  }
  return context;
}
