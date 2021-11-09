import java.net.*;  
import java.lang.*;
import java.util.Date;

public class URLVtop{  
public static void main(String[] args){  
try{  
URL url=new URL("https://vtop2.vitap.ac.in/vtop/initialProcess");  


URI uri = new URI(url.getProtocol(), url.getUserInfo(), url.getHost(), url.getPort(), url.getPath(), url.getQuery(), url.getRef());
String canonical = uri.toString();


//HttpURLConnection connection = (HttpURLConnection) url.openConnection();
//Long dateTime = connection.getLastModified();
HttpURLConnection httpCon = (HttpURLConnection) url.openConnection();
long date = httpCon.getLastModified();

System.out.println("Authority Name: "+url.getAuthority());    
System.out.println("Protocol: "+url.getProtocol());  
System.out.println("Host Name: "+url.getHost());  
System.out.println("Port Number: "+url.getPort());
System.out.println("Content Type: "+url.getContent()); 
System.out.println("Canonical Name :"+canonical);
//System.out.println("Lastly Modified date:"+dateTime);
//connection.disconnect();
if (date == 0)
      System.out.println("No last-modified information.");
else
      System.out.println("Last-Modified: " + new Date(date));
}catch(Exception e){System.out.println(e);}  
}  
}  