// The owner must provide a unique receipt path in a directory protected from other users.
// This helper stays outside its unnamed, non-kill-on-close Job for the entire drain.
// (The --pty-host mode is the exception: see PtyHost.)
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.ComponentModel;
using System.Runtime.InteropServices;

class WindowsSessionLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title;
        public int x,y,xs,ys,xc,yc,fill,flags; public short show,cbReserved;
        public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long user,kernel,periodUser,periodKernel;
        public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting data,int length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI pi);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileEx(string from,string to,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out ulong creation,out ulong exit,out ulong kernel,out ulong user);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long perProcessTime,perJobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet;
        public uint activeProcesses; public UIntPtr affinity; public uint priority,schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong reads,writes,others,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit info,int length);
    delegate bool ConsoleCtrl(uint type);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(ConsoleCtrl handler,bool add);
    static int ProcessIdentity(string[] args) {
        uint pid;
        if(args.Length!=2 || !UInt32.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out pid) || pid==0 || args[1]!=pid.ToString(System.Globalization.CultureInfo.InvariantCulture)) return 125;
        string prefix="{\"version\":1,\"type\":\"process-identity\",\"pid\":"+pid;
        IntPtr handle=OpenProcess(0x1000,false,pid); // QUERY_LIMITED_INFORMATION only; never mutation rights.
        if(handle==IntPtr.Zero) {
            int error=Marshal.GetLastWin32Error();
            // Any open failure is unknown: do not infer process death from an error code.
            Frame(prefix+",\"status\":\"unknown\",\"nativeError\":"+error+"}");
            return 125;
        }
        try {
            ulong creation,exit,kernel,user;
            if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) {
                Frame(prefix+",\"status\":\"unknown\",\"nativeError\":"+Marshal.GetLastWin32Error()+"}"); return 125;
            }
            if(creation==0) { Frame(prefix+",\"status\":\"unknown\",\"nativeError\":-1}"); return 125; }
            Frame(prefix+",\"status\":\"present\",\"creationFileTime\":\""+creation.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\"}"); return 0;
        } finally { CloseHandle(handle); }
    }
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static bool Empty(IntPtr job) {
        Accounting data; Check(QueryInformationJobObject(job,1,out data,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return data.active==0;
    }
    static string Quote(string text) {
        var value=new StringBuilder("\""); int slashes=0;
        foreach(char c in text) {
            if(c=='\0') throw new ArgumentException();
            if(c=='\\') { slashes++; continue; }
            value.Append('\\',c=='"' ? slashes*2+1 : slashes); value.Append(c); slashes=0;
        }
        value.Append('\\',slashes*2); return value.Append('"').ToString();
    }
    static string Id(string value) {
        if(value.Length<1 || value.Length>64 || !((value[0]>='a' && value[0]<='z') || (value[0]>='0' && value[0]<='9'))) throw new ArgumentException();
        foreach(char c in value) if(!((c>='a' && c<='z') || (c>='0' && c<='9') || c=='-')) throw new ArgumentException();
        return value;
    }
    static string Absolute(string value) {
        // Require a canonical local drive path. Reject relative/drive-relative, UNC and device paths.
        if(value.Length<4 || !Char.IsLetter(value[0]) || value[1]!=':' || value[2]!='\\' ||
            value.IndexOf(':',2)>=0 || !String.Equals(Path.GetFullPath(value),value,StringComparison.OrdinalIgnoreCase)) throw new ArgumentException();
        return value;
    }
    static string Bool(bool value) { return value ? "true" : "false"; }
    static int Error(Exception ex) { var win=ex as Win32Exception; return win==null ? -1 : win.NativeErrorCode; }
    static void Frame(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    // --pty-host: the root of one remote terminal (Desktop specs/windows-build-support W0-5h).
    // node-pty runs this inside its pseudoconsole; the shell shares that console and is created
    // atomically in a kill-on-close Job, so nothing it starts can escape before assignment. A
    // terminal holds no work to preserve: closing it ends everything it started, like SIGHUP.
    // The receipt goes to a file only, since stdout is the terminal screen.
    static ConsoleCtrl ptyCtrl;
    static int ptyCloseRequested;
    static readonly ManualResetEvent ptyRecorded=new ManualResetEvent(false);
    static int PtyHost(string[] args) {
        IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero,attrs=IntPtr.Zero,jobValue=IntPtr.Zero;
        bool initialized=false,launched=false,empty=false,closed=false,terminated=false,rootDone=false;
        uint rootPid=0,rootExit=0; int error=0; string terminalId="",output=null,pending=null; FileStream record=null;
        // Ctrl+C and Ctrl+Break belong to the shell. A console close (the pseudoconsole was
        // closed, logoff, shutdown) ends the tree; Windows ends this process once we return.
        ptyCtrl=type => {
            if(type==0 || type==1) return true;
            Interlocked.Exchange(ref ptyCloseRequested,1);
            ptyRecorded.WaitOne(4000);
            return true;
        };
        try {
            if(args.Length<7 || args[1]!="--terminal-id" || args[3]!="--receipt" || args[5]!="--") throw new ArgumentException();
            terminalId=Id(args[2]); output=Absolute(args[4]); string exe=Absolute(args[6]);
            if(!String.Equals(Path.GetExtension(exe),".exe",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException();
            var command=new StringBuilder(Quote(exe));
            for(int i=7;i<args.Length;i++) command.Append(' ').Append(Quote(args[i]));
            if(command.Length>=32767 || File.Exists(output)) throw new ArgumentException();
            DirectoryInfo directory=new DirectoryInfo(Path.GetDirectoryName(output));
            if(directory.Parent==null) throw new ArgumentException("Receipt directory must not be a drive root");
            for(DirectoryInfo current=directory;current!=null;current=current.Parent)
                if(!current.Exists || (current.Attributes & FileAttributes.ReparsePoint)!=0) throw new IOException("Unsafe receipt directory");
            pending=output+".pending";
            record=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough);
            Check(SetConsoleCtrlHandler(ptyCtrl,true));
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var limit=new ExtendedLimit(); limit.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(ExtendedLimit))));
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,1,0,ref size)); initialized=true;
            jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
            Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000d),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            // No STARTF_USESTDHANDLES and no new console: the shell attaches to this pseudoconsole.
            var startup=new SIX { si=new SI { cb=Marshal.SizeOf(typeof(SIX)) },attrs=attrs };
            PI pi;
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x00080000,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out pi));
            process=pi.process; thread=pi.thread; rootPid=pi.pid; launched=true;
        } catch(Exception ex) { error=Error(ex); }
        finally {
            if(initialized) DeleteProcThreadAttributeList(attrs);
            foreach(var ptr in new[]{attrs,jobValue}) if(ptr!=IntPtr.Zero) Marshal.FreeHGlobal(ptr);
        }
        if(launched) {
            while(true) {
                try {
                    if(!terminated && Interlocked.CompareExchange(ref ptyCloseRequested,0,0)==1) {
                        closed=true; Check(TerminateJobObject(job,130)); terminated=true;
                    }
                    if(!rootDone) {
                        uint wait=WaitForSingleObject(process,0); Check(wait!=0xffffffff);
                        if(wait==0) { Check(GetExitCodeProcess(process,out rootExit)); rootDone=true; }
                    }
                    empty=Empty(job);
                    // The shell left but something it started still runs: the terminal is closed.
                    if(rootDone && !empty && !terminated) { Check(TerminateJobObject(job,130)); terminated=true; }
                    if(rootDone && empty) break;
                } catch(Exception ex) { error=Error(ex); if(Interlocked.CompareExchange(ref ptyCloseRequested,0,0)==1) break; }
                Thread.Sleep(50);
            }
        }
        string json="{\"version\":1,\"type\":\"terminal-final\",\"terminalId\":\""+terminalId+"\",\"launched\":"+Bool(launched)+
            ",\"rootPid\":"+rootPid+",\"rootExit\":"+(rootDone?rootExit.ToString(System.Globalization.CultureInfo.InvariantCulture):"null")+
            ",\"jobEmpty\":"+Bool(empty)+",\"closeRequested\":"+Bool(closed)+",\"terminated\":"+Bool(terminated)+",\"nativeError\":"+error+"}";
        bool written=false;
        if(record!=null) {
            try {
                byte[] bytes=Encoding.UTF8.GetBytes(json+"\n"); record.Write(bytes,0,bytes.Length); record.Flush(true); record.Dispose();
                Check(MoveFileEx(pending,output,8)); written=true;
            } catch { record.Dispose(); }
        }
        ptyRecorded.Set();
        if(thread!=IntPtr.Zero) CloseHandle(thread);
        if(process!=IntPtr.Zero) CloseHandle(process);
        // Closing the last handle to a kill-on-close Job ends anything still inside it.
        if(job!=IntPtr.Zero) CloseHandle(job);
        return launched && rootDone && empty && error==0 && written ? (int)rootExit : 125;
    }
    static int Main(string[] args) {
        if(args.Length>0 && args[0]=="--process-identity") return ProcessIdentity(args);
        if(args.Length>0 && args[0]=="--pty-host") return PtyHost(args);
        IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero,attrs=IntPtr.Zero,jobValue=IntPtr.Zero,list=IntPtr.Zero,nul=new IntPtr(-1);
        bool initialized=false,launched=false,resumed=false,empty=false,forced=false,ownerTerminated=false,rootDone=false;
        int terminateRequested=0;
        uint rootPid=0,rootExit=0; int error=0; string launchId="",instanceId="",output=null,pending=null; FileStream record=null;
        try {
            if(args.Length<8 || args[0]!="--launch-id" || args[2]!="--instance-id" || args[4]!="--receipt" || args[6]!="--") throw new ArgumentException();
            launchId=Id(args[1]); instanceId=Id(args[3]); output=Absolute(args[5]); string exe=Absolute(args[7]);
            if(!String.Equals(Path.GetExtension(exe),".exe",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException();
            var command=new StringBuilder(Quote(exe));
            for(int i=8;i<args.Length;i++) command.Append(' ').Append(Quote(args[i]));
            if(command.Length>=32767 || File.Exists(output)) throw new ArgumentException();
            // Reserve before launch, on the same volume, with no overwrite or shared writer.
            DirectoryInfo directory=new DirectoryInfo(Path.GetDirectoryName(output));
            if(directory.Parent==null) throw new ArgumentException("Receipt directory must not be a drive root");
            for(DirectoryInfo current=directory;current!=null;current=current.Parent)
                if(!current.Exists || (current.Attributes & FileAttributes.ReparsePoint)!=0) throw new IOException("Unsafe receipt directory");
            pending=output+".pending";
            record=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough);
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var sa=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=1 };
            nul=CreateFile("NUL",0xc0000000,3,ref sa,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
            attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,2,0,ref size)); initialized=true;
            jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
            Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000d),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            list=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(list,nul);
            Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            var startup=new SIX { si=new SI { cb=Marshal.SizeOf(typeof(SIX)),flags=0x100,input=nul,output=nul,error=nul },attrs=attrs };
            PI pi;
            // JOB_LIST assigns atomically. Only NUL is inheritable via HANDLE_LIST; helper pipes stay private.
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out pi));
            process=pi.process; thread=pi.thread; rootPid=pi.pid; launched=true;
            Frame("{\"version\":1,\"type\":\"ready\",\"launchId\":\""+launchId+"\",\"instanceId\":\""+instanceId+"\",\"rootPid\":"+rootPid+"}");
            // Bounded command, no arbitrary ReadLine allocation. Parent pipe is never inherited by child.
            var input=Console.OpenStandardInput();
            foreach(byte expected in Encoding.ASCII.GetBytes("resume\n")) if(input.ReadByte()!=expected) throw new IOException("Resume handshake failed");
            uint previous=ResumeThread(thread); Check(previous!=0xffffffff);
            // Creation gives exactly one suspension. Mark running immediately after successful resume.
            resumed=true;
            if(previous!=1) error=-2;
            // Only the owner's private pipe can request an explicit forced stop. EOF is not a stop.
            // One bounded command avoids unbounded buffering; malformed input disables this reader.
            var controlReader=new Thread(() => {
                try {
                    foreach(byte expected in Encoding.ASCII.GetBytes("terminate\n")) if(input.ReadByte()!=expected) return;
                    Interlocked.Exchange(ref terminateRequested,1);
                } catch { /* Pipe loss or malformed control never authorizes termination. */ }
                finally { try { input.Dispose(); } catch { } }
            });
            controlReader.IsBackground=true; controlReader.Start();
        } catch(Exception ex) { error=Error(ex); }
        finally {
            if(initialized) DeleteProcThreadAttributeList(attrs);
            foreach(var ptr in new[]{attrs,jobValue,list}) if(ptr!=IntPtr.Zero) Marshal.FreeHGlobal(ptr);
            if(nul!=new IntPtr(-1)) CloseHandle(nul);
        }
        if(launched && !resumed) {
            // Roll back only our never-resumed process, never a running Job or a PID lookup.
            forced=true;
            while(!TerminateProcess(process,125)) {
                if(WaitForSingleObject(process,0)==0) break;
                error=Marshal.GetLastWin32Error(); Thread.Sleep(100);
            }
        }
        if(launched) {
            // Parent EOF after resume has no effect. No lifetime timeout or kill-on-close limit exists.
            // Transient observation failures retain custody and cannot turn into clean evidence.
            while(true) {
                try {
                    if(Interlocked.CompareExchange(ref terminateRequested,0,0)==1) {
                        // This is an explicit owner command, never timeout/orphan cleanup or a PID guess.
                        Check(TerminateJobObject(job,125));
                        ownerTerminated=true;
                        Interlocked.Exchange(ref terminateRequested,0);
                    }
                    uint wait=WaitForSingleObject(process,0); Check(wait!=0xffffffff);
                    if(wait==0) { Check(GetExitCodeProcess(process,out rootExit)); rootDone=true; }
                    empty=Empty(job);
                    if(rootDone && empty) break;
                } catch(Exception ex) { error=Error(ex); }
                Thread.Sleep(50);
            }
        } else if(job!=IntPtr.Zero) {
            try { empty=Empty(job); } catch(Exception ex) { error=Error(ex); }
        }
        string json="{\"version\":1,\"type\":\"final\",\"launchId\":\""+launchId+"\",\"instanceId\":\""+instanceId+
            "\",\"launched\":"+Bool(launched)+",\"resumed\":"+Bool(resumed)+",\"rootPid\":"+rootPid+
            ",\"rootExit\":"+(rootDone?rootExit.ToString(System.Globalization.CultureInfo.InvariantCulture):"null")+
            ",\"jobEmpty\":"+Bool(empty)+",\"forced\":"+Bool(forced)+",\"ownerTerminated\":"+Bool(ownerTerminated)+",\"nativeError\":"+error+"}";
        bool written=false;
        if(record!=null) {
            try {
                byte[] bytes=Encoding.UTF8.GetBytes(json+"\n"); record.Write(bytes,0,bytes.Length); record.Flush(true); record.Dispose();
                // MOVEFILE_WRITE_THROUGH, no REPLACE_EXISTING. Destination must remain unique.
                Check(MoveFileEx(pending,output,8)); written=true;
            } catch(Exception ex) { record.Dispose(); error=Error(ex); }
        }
        // A lost owner stdout must not suppress the durable receipt or end custody early.
        if(!written) json=json.Substring(0,json.LastIndexOf(":",StringComparison.Ordinal)+1)+(error==0 ? -3 : error)+"}";
        try { Frame(json); } catch { }
        if(thread!=IntPtr.Zero) CloseHandle(thread);
        if(process!=IntPtr.Zero) CloseHandle(process);
        if(job!=IntPtr.Zero) CloseHandle(job);
        return launched && resumed && rootDone && rootExit==0 && empty && !forced && !ownerTerminated && error==0 && written ? 0 : 125;
    }
}
