// Windows AppContainer launcher. Compiled with the installed .NET Framework compiler.
// The parent stays trusted; only the child and its descendants receive sandbox access.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

class AppContainerRunner {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr Sid, Capabilities; public uint Count, Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet,MaxWorkingSet; public uint ProcessLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint length,out uint needed);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr acl,out bool defaulted);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint time);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Struct<T>(T value) { IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value,p,false); return p; }
    static void VerifyContainer(IntPtr process) {
        IntPtr token; Check(OpenProcessToken(process,8,out token)); IntPtr value=Marshal.AllocHGlobal(4);
        try { uint needed; Check(GetTokenInformation(token,29,value,4,out needed)); if(Marshal.ReadInt32(value)==0) throw new InvalidOperationException("Child did not receive an AppContainer token; refusing to execute"); }
        finally { Marshal.FreeHGlobal(value); CloseHandle(token); }
    }
    static void GrantDirectory(string path,IntPtr sid) {
        var security=Directory.GetAccessControl(path);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.Modify,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(path,security);
        IntPtr descriptor; uint size; Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size));
        try { bool present,defaulted; IntPtr acl; Check(GetSecurityDescriptorSacl(descriptor,out present,out acl,out defaulted)); uint result=SetNamedSecurityInfo(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,acl); if(result!=0) throw new Win32Exception((int)result); }
        finally { LocalFree(descriptor); }
    }
    static int Main(string[] args) {
        IntPtr sid=IntPtr.Zero,attributes=IntPtr.Zero,capabilities=IntPtr.Zero,securityPtr=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero,handlesPtr=IntPtr.Zero;
        var capabilitySids=new List<IntPtr>(); PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
        try {
            if(args.Length!=6 || (args[5]!="cmd" && args[5]!="init")) throw new ArgumentException("Expected profile, workspace, encoded command, network, timeout, cmd/init mode");
            string profile=args[0],cwd=Path.GetFullPath(args[1]);
            if(!profile.StartsWith("kannapi.") || !Directory.Exists(cwd)) throw new ArgumentException("Invalid sandbox workspace");
            int hr=CreateAppContainerProfile(profile,profile,"KannaPi isolated tool execution",IntPtr.Zero,0,out sid);
            if(hr<0) { hr=DeriveAppContainerSidFromAppContainerName(profile,out sid); if(hr<0) Marshal.ThrowExceptionForHR(hr); }
            // Only the trusted first initialization may change directory ACLs.
            if(args.Length==6 && args[5]=="init") GrantDirectory(cwd,sid);
            if(args[3]=="network") {
                foreach(string text in new[]{"S-1-15-3-1","S-1-15-3-3"}) { IntPtr c; Check(ConvertStringSidToSid(text,out c)); capabilitySids.Add(c); }
            }
            if(capabilitySids.Count>0) { int size=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)); capabilities=Marshal.AllocHGlobal(size*capabilitySids.Count); for(int i=0;i<capabilitySids.Count;i++) Marshal.StructureToPtr(new SID_AND_ATTRIBUTES{Sid=capabilitySids[i],Attributes=4},IntPtr.Add(capabilities,i*size),false); }
            securityPtr=Struct(new SECURITY_CAPABILITIES{Sid=sid,Capabilities=capabilities,Count=(uint)capabilitySids.Count});
            IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeSize);
            attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,2,0,ref attributeSize));
            Check(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20009,securityPtr,(IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)),IntPtr.Zero,IntPtr.Zero));
            var output=GetStdHandle(-11); var error=GetStdHandle(-12); var input=GetStdHandle(-10);
            var handles=new[]{input,output,error}; handlesPtr=Marshal.AllocHGlobal(IntPtr.Size*3);
            for(int i=0;i<3;i++) { Check(SetHandleInformation(handles[i],1,1)); Marshal.WriteIntPtr(handlesPtr,i*IntPtr.Size,handles[i]); }
            Check(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20002,handlesPtr,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
            string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows),home=Path.Combine(cwd,".home"),temp=Path.Combine(cwd,".tmp"); Directory.CreateDirectory(home); Directory.CreateDirectory(temp);
            var environment=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
                {"SystemRoot",windows},{"WINDIR",windows},{"PATH",Path.Combine(windows,"System32")+";"+Path.Combine(windows,"System32","WindowsPowerShell","v1.0")},
                {"USERPROFILE",home},{"LOCALAPPDATA",home},{"APPDATA",home},{"TEMP",temp},{"TMP",temp},
                {"NODE_OPTIONS","--preserve-symlinks --preserve-symlinks-main"},
                {"PSModulePath",Path.Combine(windows,"System32","WindowsPowerShell","v1.0","Modules")}
            };
            var envText=new StringBuilder(); foreach(var pair in environment) envText.Append(pair.Key+"="+pair.Value+'\0'); envText.Append('\0'); env=Marshal.StringToHGlobalUni(envText.ToString());
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var limits=new EXTENDED_LIMITS{Basic=new BASIC_LIMITS{Flags=0x2000|0x200|0x8,ProcessLimit=32},JobMemory=(UIntPtr)(512UL*1024*1024)};
            IntPtr limitPtr=Struct(limits); try { Check(SetInformationJobObject(job,9,limitPtr,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS)))); } finally { Marshal.FreeHGlobal(limitPtr); }
            var si=new STARTUPINFOEX{Startup=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFOEX)),flags=0x100,input=input,output=output,error=error},Attributes=attributes};
            string shell=Path.Combine(windows,"System32","cmd.exe");
            string command="\""+shell+"\" /d /s /c \""+Encoding.Unicode.GetString(Convert.FromBase64String(args[2]))+"\"";
            Check(CreateProcess(shell,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x4|0x08000000,env,cwd,ref si,out pi));
            VerifyContainer(pi.Process);
            Check(AssignProcessToJobObject(job,pi.Process)); ResumeThread(pi.Thread);
            uint timeout=uint.Parse(args[4]); uint wait=WaitForSingleObject(pi.Process,timeout);
            if(wait==258) { TerminateJobObject(job,124); Console.Error.WriteLine("Sandbox command timed out"); return 124; }
            if(wait!=0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint exitCode; Check(GetExitCodeProcess(pi.Process,out exitCode)); return (int)exitCode;
        } catch(Exception e) { Console.Error.WriteLine("AppContainer failed: "+e.Message); return 125; }
        finally {
            // Closing the job kills all remaining descendants, including on helper termination.
            if(pi.Process!=IntPtr.Zero) { TerminateProcess(pi.Process,125); CloseHandle(pi.Process); }
            if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread); if(job!=IntPtr.Zero) CloseHandle(job);
            if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            foreach(IntPtr c in capabilitySids) LocalFree(c);
            if(sid!=IntPtr.Zero) FreeSid(sid); foreach(IntPtr p in new[]{capabilities,securityPtr,env,handlesPtr}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
        }
    }
}
