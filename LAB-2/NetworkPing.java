import java.io.IOException;
import java.net.InetAddress;
 
public class NetworkPing {
 
	
	public static void main(String[] args) throws IOException {
 
		InetAddress localhost = InetAddress.getLocalHost();
		// this code assumes IPv4 is used
		byte[] ip = localhost.getAddress();
 
		for (int i = 1; i <= 254; i++)
		{
			ip[3] = (byte)i;
			InetAddress address = InetAddress.getByAddress(ip);
		if (address.isReachable(1000))
		{
			System.out.println(address + " machine isin LAN");
		}
		else if (!address.getHostAddress().equals(address.getHostName()))
		{
			System.out.println(address + " machine is known in a DNS lookup");
		}
		else
		{
			System.out.println(address + " the host address and host name are equal, meaning it is not in LAN");
		}
		}
 
	}
}